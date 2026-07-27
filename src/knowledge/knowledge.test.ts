import { describe, expect, it, vi } from 'vitest';
import type { Chunk, Document, DocumentRepository } from '../db';
import {
  chunkText,
  createKnowledgeIndex,
  extractPlainText,
  isSupportedMimeType,
} from './index';

const NOW = 1_753_600_000_000;

/**
 * An in-memory document store.
 *
 * The real SQL path — cascades, BLOB round-trips, chunk counting — is covered
 * against actual SQLite in `db.test.ts`, so this fake isolates chunking and
 * ranking from storage entirely.
 */
function fakeDocuments(): DocumentRepository & { docs: Document[]; chunks: Chunk[] } {
  const docs: Document[] = [];
  const chunks: Chunk[] = [];

  return {
    docs,
    chunks,
    async add(document) {
      docs.push(document);
    },
    async list() {
      return [...docs];
    },
    async remove(id) {
      const index = docs.findIndex((doc) => doc.id === id);
      if (index >= 0) docs.splice(index, 1);
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i].documentId === id) chunks.splice(i, 1);
      }
    },
    async addChunks(incoming) {
      chunks.push(...incoming);
    },
    async allEmbedded() {
      return chunks.filter((chunk) => chunk.embedding !== null);
    },
    async chunk(id) {
      return chunks.find((c) => c.id === id) ?? null;
    },
    async chunksFor(documentId) {
      return chunks
        .filter((c) => c.documentId === documentId)
        .sort((a, b) => a.ordinal - b.ordinal);
    },
  };
}

describe('chunking', () => {
  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const chunks = chunkText('A short note about the lease.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('A short note about the lease.');
    expect(chunks[0].startOffset).toBe(0);
  });

  it('respects the documented size ceiling', () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i}. ${'word '.repeat(40)}`,
    ).join('\n\n');

    const chunks = chunkText(paragraphs, {
      targetChars: 400,
      overlapChars: 50,
      minChars: 120,
    });
    expect(chunks.length).toBeGreaterThan(1);

    // Two things legitimately push past the target: prepended overlap, and
    // absorbing a tail shorter than minChars. Both are bounded, and the sum is
    // the real contract callers can rely on.
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400 + 120 + 50 + 2);
    }
  });

  it('prefers paragraph boundaries over cutting mid-sentence', () => {
    const text = `${'a'.repeat(300)}\n\n${'b'.repeat(300)}`;
    const chunks = chunkText(text, { targetChars: 350, overlapChars: 0, minChars: 0 });

    // Each chunk should be a whole paragraph rather than a blind 350-char cut.
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('a'.repeat(300));
    expect(chunks[1].text).toBe('b'.repeat(300));
  });

  it('falls back to sentence boundaries inside a long paragraph', () => {
    const sentences = Array.from({ length: 8 }, (_, i) => `Sentence number ${i}.`).join(
      ' ',
    );
    const chunks = chunkText(sentences, { targetChars: 60, overlapChars: 0, minChars: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    // A sentence-aware split should not strand a fragment starting mid-word.
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^Sentence/);
    }
  });

  it('splits an unbroken run that has no separator at all', () => {
    // 1000 chars at a 300 target leaves a 100-char tail. That tail is shorter
    // than minChars, so it is absorbed rather than embedded alone — bounded by
    // target + minChars, never unbounded.
    const chunks = chunkText('x'.repeat(1000), {
      targetChars: 300,
      overlapChars: 0,
      minChars: 120,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(300 + 120);
    }
  });

  it('never lets a short tail push a chunk past the ceiling unboundedly', () => {
    // The regression this guards: absorbing a sub-minChars segment used to
    // ignore the target entirely.
    const chunks = chunkText('y'.repeat(5000), {
      targetChars: 500,
      overlapChars: 0,
      minChars: 200,
    });

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(500 + 200);
    }
  });

  it('repeats the tail of the previous chunk so boundaries are recoverable', () => {
    const text = `${'a'.repeat(300)}\n\nDISTINCTIVE_MARKER ${'b'.repeat(280)}`;
    const [, second] = chunkText(text, {
      targetChars: 350,
      overlapChars: 40,
      minChars: 0,
    });

    // The second chunk should carry context from the first.
    expect(second.text.startsWith('a')).toBe(true);
    expect(second.text).toContain('DISTINCTIVE_MARKER');
  });

  it('numbers chunks consecutively from zero', () => {
    const text = Array.from({ length: 6 }, (_, i) => `${'p'.repeat(200)}${i}`).join('\n\n');
    const chunks = chunkText(text, { targetChars: 250, overlapChars: 10, minChars: 0 });
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('reports offsets that advance through the document', () => {
    const text = Array.from({ length: 5 }, (_, i) => `${'q'.repeat(200)}${i}`).join('\n\n');
    const chunks = chunkText(text, { targetChars: 250, overlapChars: 0, minChars: 0 });

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startOffset).toBeGreaterThan(chunks[i - 1].startOffset);
    }
  });

  it('merges a tiny trailing segment rather than embedding it alone', () => {
    // A three-word chunk embeds to noise and pollutes every subsequent search.
    const text = `${'a'.repeat(300)}\n\nok`;
    const chunks = chunkText(text, { targetChars: 320, overlapChars: 0, minChars: 100 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('ok');
  });
});

describe('text extraction', () => {
  it('leaves plain text untouched', () => {
    const source = '# Not markdown\n**stays**';
    expect(extractPlainText(source, 'text/plain')).toBe(source);
  });

  it('flattens markdown syntax while keeping the words', () => {
    const markdown = [
      '# Lease Agreement',
      '',
      'Rent is **due** on the *first* of each month.',
      '',
      '> Late fees apply.',
      '',
      'See [the schedule](https://example.com/schedule).',
    ].join('\n');

    const plain = extractPlainText(markdown, 'text/markdown');

    expect(plain).toContain('Lease Agreement');
    expect(plain).toContain('Rent is due on the first of each month.');
    expect(plain).toContain('Late fees apply.');
    expect(plain).toContain('the schedule');
    // The URL carries no retrieval signal and shifts the embedding.
    expect(plain).not.toContain('https://example.com');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('# ');
  });

  it('recognises the file types it can actually read', () => {
    expect(isSupportedMimeType('text/markdown')).toBe(true);
    expect(isSupportedMimeType('text/plain')).toBe(true);
    expect(isSupportedMimeType('application/pdf')).toBe(false);
    expect(isSupportedMimeType(null)).toBe(false);
  });
});

describe('index', () => {
  /** Embeds by keyword presence so ranking is deterministic. */
  const keywordEmbed = (keywords: string[]) => async (text: string) =>
    new Float32Array(keywords.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)));

  it('stores a document and its chunks', async () => {
    const documents = fakeDocuments();
    const index = createKnowledgeIndex({ documents, now: () => NOW });

    const document = await index.ingest(
      {
        id: 'd1',
        title: 'Lease.md',
        content: `${'a'.repeat(300)}\n\n${'b'.repeat(300)}`,
        mimeType: 'text/plain',
      },
      { targetChars: 350, overlapChars: 0, minChars: 0 },
    );

    expect(document.chunkCount).toBe(2);
    expect(documents.chunks).toHaveLength(2);
    expect(documents.chunks[0].documentId).toBe('d1');
  });

  it('ingests without an embedder, leaving chunks unsearchable but stored', async () => {
    const documents = fakeDocuments();
    const index = createKnowledgeIndex({ documents, now: () => NOW });

    await index.ingest(
      { id: 'd1', title: 'Notes', content: 'some content here', mimeType: 'text/plain' },
      { targetChars: 100 },
    );

    expect(documents.chunks).toHaveLength(1);
    expect(documents.chunks[0].embedding).toBeNull();
    expect(await index.search('content')).toEqual([]);
  });

  it('keeps the import when one chunk fails to embed', async () => {
    const documents = fakeDocuments();
    let calls = 0;
    const index = createKnowledgeIndex({
      documents,
      now: () => NOW,
      embed: async () => {
        calls++;
        if (calls === 1) throw new Error('context evicted');
        return new Float32Array([1, 0]);
      },
    });

    await index.ingest(
      {
        id: 'd1',
        title: 'Notes',
        content: `${'a'.repeat(300)}\n\n${'b'.repeat(300)}`,
        mimeType: 'text/plain',
      },
      { targetChars: 350, overlapChars: 0, minChars: 0 },
    );

    // One chunk loses searchability; the document still imports.
    expect(documents.chunks).toHaveLength(2);
    expect(documents.chunks[0].embedding).toBeNull();
    expect(documents.chunks[1].embedding).not.toBeNull();
  });

  it('ranks the most relevant chunk first', async () => {
    const documents = fakeDocuments();
    const index = createKnowledgeIndex({
      documents,
      now: () => NOW,
      embed: keywordEmbed(['rent', 'parking']),
    });

    await index.ingest(
      {
        id: 'd1',
        title: 'Lease',
        content: `Rent is due monthly. ${'x'.repeat(200)}\n\nParking is extra. ${'y'.repeat(200)}`,
        mimeType: 'text/plain',
      },
      { targetChars: 250, overlapChars: 0, minChars: 0 },
    );

    const hits = await index.search('what about parking');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text.toLowerCase()).toContain('parking');
    expect(hits[0].documentTitle).toBe('Lease');
  });

  it('returns nothing rather than noise when nothing is relevant', async () => {
    const documents = fakeDocuments();
    const index = createKnowledgeIndex({
      documents,
      now: () => NOW,
      embed: keywordEmbed(['rent', 'parking']),
    });

    await index.ingest(
      {
        id: 'd1',
        title: 'Lease',
        content: 'Rent is due monthly.',
        mimeType: 'text/plain',
      },
      { targetChars: 250 },
    );

    // The query matches no keyword, so every vector is orthogonal.
    expect(await index.search('astrophysics')).toEqual([]);
  });

  it('honours the result limit', async () => {
    const documents = fakeDocuments();
    const index = createKnowledgeIndex({
      documents,
      now: () => NOW,
      embed: keywordEmbed(['rent']),
    });

    await index.ingest(
      {
        id: 'd1',
        title: 'Lease',
        content: Array.from({ length: 6 }, () => `Rent clause ${'z'.repeat(200)}`).join(
          '\n\n',
        ),
        mimeType: 'text/plain',
      },
      { targetChars: 250, overlapChars: 0, minChars: 0 },
    );

    expect((await index.search('rent', 2)).length).toBeLessThanOrEqual(2);
  });

  it('returns nothing when the embedder is unavailable', async () => {
    const documents = fakeDocuments();
    const embed = vi.fn(async (): Promise<Float32Array> => {
      throw new Error('no model loaded');
    });
    const index = createKnowledgeIndex({ documents, now: () => NOW, embed });

    // Honest emptiness beats a thrown turn; the tool layer explains it.
    expect(await index.search('anything')).toEqual([]);
  });

  it('reads a chunk together with its neighbours', async () => {
    const documents = fakeDocuments();
    const index = createKnowledgeIndex({ documents, now: () => NOW });

    await index.ingest(
      {
        id: 'd1',
        title: 'Lease',
        content: Array.from({ length: 5 }, (_, i) => `${'p'.repeat(200)}${i}`).join('\n\n'),
        mimeType: 'text/plain',
      },
      { targetChars: 250, overlapChars: 0, minChars: 0 },
    );

    const around = await index.read('d1_c2', 1);
    expect(around.map((hit) => hit.ordinal)).toEqual([1, 2, 3]);
  });

  it('returns nothing for an unknown chunk instead of throwing', async () => {
    const index = createKnowledgeIndex({ documents: fakeDocuments(), now: () => NOW });
    expect(await index.read('nope')).toEqual([]);
  });
});
