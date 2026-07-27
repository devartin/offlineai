/**
 * The document index.
 *
 * This is what lets the assistant answer questions about the user's own files
 * without any of them leaving the device. Retrieval runs as brute-force cosine
 * over embeddings stored as BLOBs: at 128–768 dimensions and realistic personal
 * corpus sizes (under ~50k chunks) that is single-digit milliseconds, and it
 * removes an entire native dependency compared to a vector extension.
 *
 * Chunking is the part that actually decides retrieval quality. Splitting on a
 * fixed character count cuts sentences in half and produces chunks that embed
 * to nothing useful, so this splits on real structure — paragraphs first, then
 * sentences, then words — and only ever falls back to a hard cut when a single
 * run of text exceeds the budget.
 *
 * This module lives in a sealed directory: it may not touch the network.
 */

import type { Chunk, Document, DocumentRepository } from '../db';
import { cosineSimilarity } from '../tools/builtin/memory';

export interface ChunkingOptions {
  /**
   * Target chunk size in characters. Roughly 4 characters per token, so 1600
   * lands near 400 tokens — small enough that several fit in a phone-sized
   * context alongside the conversation.
   */
  targetChars?: number;
  /**
   * How much of the previous chunk to repeat at the start of the next.
   * Overlap is what stops an answer being lost at a boundary.
   */
  overlapChars?: number;
  /** Segments shorter than this are merged into their predecessor. */
  minChars?: number;
}

const DEFAULT_TARGET_CHARS = 1600;
const DEFAULT_OVERLAP_CHARS = 200;
const DEFAULT_MIN_CHARS = 120;

export interface TextChunk {
  text: string;
  ordinal: number;
  /** Character offset in the source document, for citation. */
  startOffset: number;
}

/**
 * Splits text on the strongest boundary that fits.
 *
 * Returns segments no larger than `limit`, preferring paragraph breaks over
 * sentence breaks over word breaks. Text is only cut mid-word when a single
 * unbroken run is itself longer than the limit.
 */
function splitOnBoundaries(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const separators = ['\n\n', '\n', '. ', '? ', '! ', '; ', ' '];

  for (const separator of separators) {
    if (!text.includes(separator)) continue;

    const pieces: string[] = [];
    let current = '';

    for (const part of text.split(separator)) {
      const candidate = current ? current + separator + part : part;

      if (candidate.length <= limit) {
        current = candidate;
        continue;
      }

      if (current) {
        pieces.push(current);
        current = '';
      }

      // A single part may still exceed the limit; recurse onto a weaker
      // separator rather than emitting an oversized chunk.
      if (part.length > limit) {
        pieces.push(...splitOnBoundaries(part, limit));
      } else {
        current = part;
      }
    }

    if (current) pieces.push(current);
    if (pieces.length > 1) return pieces;
  }

  // No usable separator — a single unbroken run longer than the limit.
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    pieces.push(text.slice(index, index + limit));
  }
  return pieces;
}

/**
 * Turns a document into overlapping chunks.
 *
 * Overlap is applied by prefixing each chunk with the tail of its predecessor,
 * so a sentence spanning a boundary appears whole in at least one chunk.
 */
export function chunkText(text: string, options: ChunkingOptions = {}): TextChunk[] {
  const targetChars = options.targetChars ?? DEFAULT_TARGET_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;

  const normalised = text.replace(/\r\n/g, '\n').trim();
  if (normalised.length === 0) return [];

  const segments = splitOnBoundaries(normalised, targetChars);

  // Merge runs too short to be worth embedding on their own. A three-word chunk
  // embeds to noise and pollutes every search.
  //
  // Absorbing a short tail is allowed to overshoot the target, but only by up
  // to `minChars` — without that ceiling a trailing fragment could push a chunk
  // arbitrarily past the size the caller asked for.
  const merged: string[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const combined = previous === undefined ? 0 : previous.length + segment.length + 1;

    const canMerge =
      previous !== undefined &&
      (combined <= targetChars ||
        (segment.length < minChars && combined <= targetChars + minChars));

    if (canMerge) {
      merged[merged.length - 1] = `${previous}\n${segment}`;
    } else {
      merged.push(segment);
    }
  }

  const chunks: TextChunk[] = [];
  let searchFrom = 0;

  merged.forEach((segment, index) => {
    const trimmed = segment.trim();
    if (trimmed.length === 0) return;

    // Offsets are located rather than accumulated, because merging and trimming
    // both change lengths in ways a running counter would drift on.
    const located = normalised.indexOf(trimmed, searchFrom);
    const startOffset = located >= 0 ? located : searchFrom;
    searchFrom = startOffset + trimmed.length;

    const previous = merged[index - 1]?.trim();
    const overlap =
      previous && overlapChars > 0 ? previous.slice(-overlapChars).trimStart() : '';

    chunks.push({
      text: overlap ? `${overlap}\n${trimmed}` : trimmed,
      ordinal: chunks.length,
      startOffset,
    });
  });

  return chunks;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

const SUPPORTED: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

export function isSupportedMimeType(mimeType: string | null | undefined): boolean {
  return mimeType !== null && mimeType !== undefined && SUPPORTED.has(mimeType);
}

/**
 * Strips markup that adds no retrieval signal.
 *
 * Markdown syntax embeds as noise — `###` and `**` shift a chunk's vector
 * without changing its meaning — so headings and emphasis are flattened while
 * the words themselves are preserved.
 */
export function extractPlainText(source: string, mimeType: string): string {
  if (mimeType !== 'text/markdown') return source;

  return source
    .replace(/```\w*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*_]{3,}$/gm, '');
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  text: string;
  score: number;
  ordinal: number;
}

export interface IngestInput {
  id: string;
  title: string;
  content: string;
  mimeType: string;
  sourceUri?: string;
}

export interface KnowledgeIndex {
  ingest(input: IngestInput, options?: ChunkingOptions): Promise<Document>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
  /** Returns a chunk with its neighbours, for reading around a hit. */
  read(chunkId: string, radius?: number): Promise<SearchHit[]>;
  remove(documentId: string): Promise<void>;
  list(): Promise<Document[]>;
}

export interface KnowledgeDeps {
  documents: DocumentRepository;
  /** Embeds text. Without it, ingestion still stores chunks but search is empty. */
  embed?: (text: string) => Promise<Float32Array>;
  now?: () => number;
}

const DEFAULT_SEARCH_LIMIT = 5;

/** Below this cosine score a chunk is unrelated, and returning it misleads. */
const MIN_RELEVANCE = 0.25;

export function createKnowledgeIndex(deps: KnowledgeDeps): KnowledgeIndex {
  const { documents, embed, now = Date.now } = deps;

  function toHit(chunk: Chunk, title: string, score: number): SearchHit {
    return {
      chunkId: chunk.id,
      documentId: chunk.documentId,
      documentTitle: title,
      text: chunk.text,
      score,
      ordinal: chunk.ordinal,
    };
  }

  return {
    async ingest(input, options) {
      const plain = extractPlainText(input.content, input.mimeType);
      const pieces = chunkText(plain, options);

      const document: Document = {
        id: input.id,
        title: input.title,
        sourceUri: input.sourceUri ?? null,
        mimeType: input.mimeType,
        byteSize: input.content.length,
        addedAt: now(),
        chunkCount: pieces.length,
      };
      await documents.add(document);

      if (pieces.length === 0) return document;

      // Embeddings are computed sequentially rather than in parallel: they run
      // through the single llama context, so concurrent requests would serialise
      // anyway while multiplying peak memory.
      const stored: Chunk[] = [];
      for (const piece of pieces) {
        let embedding: Float32Array | null = null;
        if (embed) {
          try {
            embedding = await embed(piece.text);
          } catch {
            // A failed embedding costs this chunk its searchability, not the
            // whole import.
            embedding = null;
          }
        }

        stored.push({
          id: `${input.id}_c${piece.ordinal}`,
          documentId: input.id,
          ordinal: piece.ordinal,
          text: piece.text,
          page: null,
          embedding,
        });
      }

      await documents.addChunks(stored);
      return document;
    },

    async search(query, limit = DEFAULT_SEARCH_LIMIT) {
      if (!embed) return [];

      let queryEmbedding: Float32Array;
      try {
        queryEmbedding = await embed(query);
      } catch {
        // No embedding model loaded. Returning nothing is honest; the tool
        // layer turns it into a message the model can act on.
        return [];
      }

      const chunks = await documents.allEmbedded();
      if (chunks.length === 0) return [];

      const titles = new Map((await documents.list()).map((doc) => [doc.id, doc.title]));

      return chunks
        .map((chunk) =>
          toHit(
            chunk,
            titles.get(chunk.documentId) ?? 'Untitled',
            chunk.embedding ? cosineSimilarity(queryEmbedding, chunk.embedding) : 0,
          ),
        )
        .filter((hit) => hit.score >= MIN_RELEVANCE)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    async read(chunkId, radius = 1) {
      const target = await documents.chunk(chunkId);
      if (!target) return [];

      const siblings = await documents.chunksFor(target.documentId);
      const titles = new Map((await documents.list()).map((doc) => [doc.id, doc.title]));
      const title = titles.get(target.documentId) ?? 'Untitled';

      return siblings
        .filter((chunk) => Math.abs(chunk.ordinal - target.ordinal) <= radius)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((chunk) => toHit(chunk, title, chunk.id === chunkId ? 1 : 0));
    },

    remove: (documentId) => documents.remove(documentId),
    list: () => documents.list(),
  };
}
