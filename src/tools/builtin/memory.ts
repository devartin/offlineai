/**
 * Long-term memory.
 *
 * A model with an 8k context forgets everything about you between sessions.
 * These two tools are what turn it from a stateless chatbot into something that
 * knows you take your coffee black and that your sister's birthday is in March.
 *
 * Memory also has the sharpest privacy edge in the app: it writes durable facts
 * about a person to disk. So `memory.remember` is marked `mutates`, which means
 * the kernel re-confirms it on every single call with the exact text visible —
 * a standing "always allow" can never silently accumulate a dossier.
 *
 * Retrieval degrades rather than failing. Cosine similarity over embeddings is
 * used when the embedding model is installed; before that, a token-overlap score
 * keeps recall working instead of returning nothing.
 */

import { z } from 'zod';
import type { Memory, MemoryRepository } from '../../db';
import { defineTool, type ToolDefinition } from '../kernel/types';

export interface MemoryDeps {
  repository: MemoryRepository;
  /**
   * Embeds text for semantic recall. Optional: when absent, or when it throws,
   * retrieval falls back to lexical overlap rather than disabling the tool.
   */
  embed?: (text: string) => Promise<Float32Array>;
  /** Injectable so tests are not at the mercy of the wall clock. */
  now?: () => number;
}

/** How many memories `recall` returns when the model does not ask for a count. */
const DEFAULT_RECALL_LIMIT = 5;

/** Below this score a match is noise, and returning it would mislead the model. */
const MIN_SCORE = 0.05;

/** Above this lexical overlap, two memories are treated as the same fact. */
const DUPLICATE_THRESHOLD = 0.85;

/**
 * Cosine similarity between two vectors.
 *
 * Returns 0 for mismatched dimensions rather than throwing — a memory embedded
 * by a previous model should be ignored, not crash recall.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dot / magnitude;
}

/**
 * Words that carry no retrieval signal.
 *
 * Filtering by length alone is not enough: "the", "and" and "for" are all three
 * characters, and matching on them would score every memory equally and make
 * recall useless.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'his', 'her', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'with', 'from', 'have', 'has', 'had', 'does',
  'did', 'not', 'but', 'you', 'your', 'about', 'what', 'when', 'where', 'which',
  'who', 'how', 'why', 'can', 'will', 'would', 'should', 'could', 'user', 'they',
]);

/** Splits text into comparable lowercase tokens, discarding punctuation. */
function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

/** Shortest shared prefix length required to treat two tokens as the same word. */
const STEM_PREFIX = 4;

/**
 * Whether two tokens plausibly share a root.
 *
 * A real stemmer is overkill here, but exact matching is too brittle for the
 * queries recall actually receives — "dietary preferences" must reach "prefers
 * vegetarian food", and no exact-token scheme connects those.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;

  const shortest = Math.min(a.length, b.length);
  if (shortest < STEM_PREFIX) return false;

  let common = 0;
  while (common < shortest && a[common] === b[common]) common++;
  return common >= STEM_PREFIX;
}

/**
 * Jaccard overlap with prefix-tolerant matching, used when no embedding model
 * is available.
 *
 * Deliberately crude. Its job is to make recall useful on day one, before the
 * user has downloaded a 300MB embedding model — not to compete with one.
 */
export function lexicalScore(query: string, content: string): number {
  const queryTokens = tokenise(query);
  const contentTokens = tokenise(content);
  if (queryTokens.size === 0 || contentTokens.size === 0) return 0;

  let shared = 0;
  for (const token of queryTokens) {
    for (const candidate of contentTokens) {
      if (tokensMatch(token, candidate)) {
        shared++;
        break;
      }
    }
  }

  return shared / (queryTokens.size + contentTokens.size - shared);
}

export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  rememberedAt: number;
}

/**
 * Ranks memories against a query.
 *
 * Exported separately from the tool so the ranking can be tested without a
 * database or a model behind it.
 */
export function rankMemories(
  memories: readonly Memory[],
  query: string,
  queryEmbedding: Float32Array | null,
  limit: number,
): RecallMatch[] {
  return memories
    .map((memory) => {
      // Semantic scoring only applies when both sides were embedded by the same
      // model; otherwise the comparison is meaningless and lexical is honest.
      const semantic =
        queryEmbedding && memory.embedding
          ? cosineSimilarity(queryEmbedding, memory.embedding)
          : null;

      return {
        id: memory.id,
        content: memory.content,
        rememberedAt: memory.createdAt,
        score: semantic ?? lexicalScore(query, memory.content),
      };
    })
    .filter((match) => match.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Builds the memory tools against a repository.
 *
 * A factory rather than module-level constants because these tools need the
 * database, and the kernel is deliberately ignorant of it.
 */
export function createMemoryTools(deps: MemoryDeps): ToolDefinition<any, any>[] {
  const { repository, embed, now = Date.now } = deps;

  /** Embeds text, returning null if no model is loaded or embedding fails. */
  async function tryEmbed(text: string): Promise<Float32Array | null> {
    if (!embed) return null;
    try {
      return await embed(text);
    } catch {
      // Recall degrading to lexical is far better than a tool call failing.
      return null;
    }
  }

  const remember = defineTool({
    name: 'memory.remember',
    description:
      'Store a durable fact about the user so it can be recalled in future conversations. ' +
      'Use this only for stable preferences and facts the user would expect to be remembered ' +
      '(e.g. "prefers metric units", "is allergic to peanuts"), never for passing details of ' +
      'the current conversation.',
    parameters: z.object({
      content: z
        .string()
        .min(3)
        .max(500)
        .describe('The fact to remember, written as a short standalone statement'),
      source: z
        .string()
        .max(120)
        .optional()
        .describe('Where this came from, e.g. "user said so directly"'),
    }),
    scopes: ['write:memory'],
    // Every write re-confirms with the text visible. This is the tool most
    // capable of quietly accumulating personal data, so it never gets a
    // standing grant.
    mutates: true,
    timeoutMs: 5_000,
    handler: async ({ content, source }) => {
      const trimmed = content.trim();
      const existing = await repository.all();

      // Near-duplicates are common because models re-remember things they were
      // just told. Storing them would degrade recall by crowding the top of the
      // ranking with the same fact.
      const duplicate = existing.find(
        (memory) => lexicalScore(trimmed, memory.content) > DUPLICATE_THRESHOLD,
      );
      if (duplicate) {
        return { id: duplicate.id, stored: false, reason: 'Already remembered' };
      }

      const id = `mem_${now()}_${existing.length}`;
      await repository.add({
        id,
        content: trimmed,
        source: source ?? null,
        embedding: await tryEmbed(trimmed),
        createdAt: now(),
      });

      return { id, stored: true };
    },
  });

  const recall = defineTool({
    name: 'memory.recall',
    description:
      'Search previously remembered facts about the user. Call this before answering ' +
      "anything that depends on the user's preferences, history or personal details.",
    parameters: z.object({
      query: z
        .string()
        .min(2)
        .max(300)
        .describe('What to look for, e.g. "dietary preferences"'),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    scopes: ['read:memory'],
    timeoutMs: 5_000,
    handler: async ({ query, limit }) => {
      const memories = await repository.all();
      if (memories.length === 0) {
        // An explicit empty answer stops the model inventing a memory to fill
        // the silence.
        return { matches: [], note: 'Nothing has been remembered yet.' };
      }

      const matches = rankMemories(
        memories,
        query,
        await tryEmbed(query),
        limit ?? DEFAULT_RECALL_LIMIT,
      );

      return matches.length > 0
        ? { matches }
        : { matches: [], note: 'No stored memory matches that.' };
    },
  });

  return [remember, recall];
}
