import { describe, expect, it, vi } from 'vitest';
import type { Memory, MemoryRepository } from '../../db';
import type { ToolDefinition } from '../kernel/types';
import { cosineSimilarity, createMemoryTools, lexicalScore, rankMemories } from './memory';

const NOW = 1_753_600_000_000;
const ctx = { signal: new AbortController().signal };

/**
 * An in-memory repository.
 *
 * The real SQL path is covered against actual SQLite in `db.test.ts`, so this
 * fake isolates ranking and consent semantics from storage entirely.
 */
function fakeRepository(seed: Memory[] = []): MemoryRepository & { rows: Memory[] } {
  const rows = [...seed];
  return {
    rows,
    async add(memory) {
      rows.push(memory);
    },
    async all() {
      return [...rows].sort((a, b) => b.createdAt - a.createdAt);
    },
    async remove(id) {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
    async clear() {
      rows.length = 0;
    },
  };
}

function memory(id: string, content: string, embedding?: Float32Array): Memory {
  return { id, content, source: null, embedding: embedding ?? null, createdAt: NOW };
}

/** Splits the tool pair by name so tests read clearly. */
function tools(deps: Parameters<typeof createMemoryTools>[0]) {
  const list = createMemoryTools(deps);
  const byName = (name: string) =>
    list.find((tool) => tool.name === name) as ToolDefinition<any, any>;
  return { remember: byName('memory.remember'), recall: byName('memory.recall') };
}

describe('cosine similarity', () => {
  it('scores identical vectors at 1 and orthogonal ones at 0', () => {
    expect(
      cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0])),
    ).toBeCloseTo(1, 6);
    expect(
      cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])),
    ).toBeCloseTo(0, 6);
  });

  it('ignores magnitude, comparing direction only', () => {
    expect(
      cosineSimilarity(new Float32Array([1, 1]), new Float32Array([5, 5])),
    ).toBeCloseTo(1, 6);
  });

  it('returns 0 rather than throwing on mismatched dimensions', () => {
    // A memory embedded by a previously installed model must be ignored, not
    // crash recall for every other memory.
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(
      0,
    );
    expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(0);
  });

  it('returns 0 for a zero vector instead of NaN', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe('lexical fallback', () => {
  it('scores overlapping text above unrelated text', () => {
    const related = lexicalScore('dietary preferences', 'prefers vegetarian food');
    const unrelated = lexicalScore('dietary preferences', 'lives in Manchester');
    expect(related).toBeGreaterThan(unrelated);
  });

  it('ignores case and punctuation', () => {
    expect(lexicalScore('Metric units!', 'metric units')).toBeGreaterThan(0.5);
  });

  it('discards short filler words', () => {
    // "the" and "is" carry no signal; matching on them would rank every memory
    // equally and make recall useless.
    expect(lexicalScore('the is a', 'the is a totally different fact')).toBe(0);
  });
});

describe('ranking', () => {
  it('prefers semantic similarity when both sides are embedded', () => {
    const matches = rankMemories(
      [
        memory('m1', 'completely unrelated wording', new Float32Array([1, 0])),
        memory('m2', 'also unrelated wording', new Float32Array([0, 1])),
      ],
      'query text',
      new Float32Array([1, 0]),
      5,
    );
    expect(matches[0].id).toBe('m1');
  });

  it('falls back to lexical scoring when nothing is embedded', () => {
    const matches = rankMemories(
      [memory('m1', 'prefers metric units'), memory('m2', 'enjoys hiking')],
      'what units does the user prefer',
      null,
      5,
    );
    expect(matches[0].id).toBe('m1');
  });

  it('drops matches below the noise floor', () => {
    expect(
      rankMemories([memory('m1', 'enjoys hiking')], 'quantum chromodynamics', null, 5),
    ).toEqual([]);
  });

  it('honours the limit', () => {
    const memories = ['metric units', 'metric system', 'metric measurements'].map(
      (text, index) => memory(`m${index}`, text),
    );
    expect(rankMemories(memories, 'metric', null, 2)).toHaveLength(2);
  });
});

describe('memory.remember', () => {
  it('is marked as mutating so the kernel re-confirms every write', () => {
    // The load-bearing privacy property: no standing grant can ever silently
    // accumulate durable facts about a person.
    const { remember } = tools({ repository: fakeRepository() });
    expect(remember.mutates).toBe(true);
    expect(remember.scopes).toEqual(['write:memory']);
  });

  it('stores a new fact', async () => {
    const repository = fakeRepository();
    const { remember } = tools({ repository, now: () => NOW });

    const result = await remember.handler({ content: 'Prefers metric units' }, ctx);
    expect(result).toMatchObject({ stored: true });
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0].content).toBe('Prefers metric units');
  });

  it('refuses to store a near-duplicate twice', async () => {
    // Models re-remember things they were just told; a second row would crowd
    // the top of every future ranking with the same fact.
    const repository = fakeRepository([memory('m1', 'Prefers metric units')]);
    const { remember } = tools({ repository, now: () => NOW });

    const result = await remember.handler({ content: 'prefers metric units' }, ctx);
    expect(result).toMatchObject({ stored: false, id: 'm1' });
    expect(repository.rows).toHaveLength(1);
  });

  it('embeds the fact when an embedder is available', async () => {
    const repository = fakeRepository();
    const embed = vi.fn(async () => new Float32Array([0.5, 0.5]));
    const { remember } = tools({ repository, embed, now: () => NOW });

    await remember.handler({ content: 'Allergic to peanuts' }, ctx);
    expect(embed).toHaveBeenCalledWith('Allergic to peanuts');
    expect(repository.rows[0].embedding).not.toBeNull();
  });

  it('still stores the fact when embedding fails', async () => {
    // No loaded model must not mean no memory — it only means lexical recall.
    const repository = fakeRepository();
    const { remember } = tools({
      repository,
      embed: async () => {
        throw new Error('no model loaded');
      },
      now: () => NOW,
    });

    await expect(
      remember.handler({ content: 'Allergic to peanuts' }, ctx),
    ).resolves.toMatchObject({ stored: true });
    expect(repository.rows[0].embedding).toBeNull();
  });

  it('rejects content too short to be a fact', () => {
    const { remember } = tools({ repository: fakeRepository() });
    expect(remember.parameters.safeParse({ content: 'ok' }).success).toBe(false);
    expect(remember.parameters.safeParse({ content: 'Prefers tea' }).success).toBe(true);
  });
});

describe('memory.recall', () => {
  it('reads rather than writes', () => {
    const { recall } = tools({ repository: fakeRepository() });
    expect(recall.scopes).toEqual(['read:memory']);
    expect(recall.mutates).toBeUndefined();
  });

  it('says so explicitly when nothing has been remembered', async () => {
    // Silence invites the model to invent a memory to fill it.
    const { recall } = tools({ repository: fakeRepository() });
    const result = await recall.handler({ query: 'anything' }, ctx);
    expect(result.matches).toEqual([]);
    expect(result.note).toContain('Nothing');
  });

  it('says so explicitly when nothing matches', async () => {
    const repository = fakeRepository([memory('m1', 'enjoys hiking')]);
    const { recall } = tools({ repository });

    const result = await recall.handler({ query: 'quantum chromodynamics' }, ctx);
    expect(result.matches).toEqual([]);
    expect(result.note).toContain('No stored memory');
  });

  it('returns the best match first', async () => {
    const repository = fakeRepository([
      memory('m1', 'enjoys hiking in the Peak District'),
      memory('m2', 'prefers metric units for everything'),
    ]);
    const { recall } = tools({ repository });

    const result = await recall.handler({ query: 'which units are preferred' }, ctx);
    expect(result.matches[0].id).toBe('m2');
  });

  it('falls back to lexical recall when embedding throws', async () => {
    const repository = fakeRepository([memory('m1', 'prefers metric units')]);
    const { recall } = tools({
      repository,
      embed: async () => {
        throw new Error('no model loaded');
      },
    });

    const result = await recall.handler({ query: 'metric units' }, ctx);
    expect(result.matches).toHaveLength(1);
  });
});
