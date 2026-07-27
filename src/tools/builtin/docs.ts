/**
 * Document search and retrieval.
 *
 * These are the tools that let the assistant answer "what does my lease say
 * about parking?" — the class of question a cloud assistant can only answer if
 * you upload the lease.
 *
 * The two-step shape is deliberate. `docs.search` returns short excerpts across
 * the whole corpus so the model can see what exists without burning its
 * context; `docs.read` then pulls the full passage plus neighbours for the one
 * hit that matters. A single tool returning whole documents would blow an 8k
 * context on the first call.
 *
 * Both tools only read, so a standing grant is safe and they never re-prompt.
 */

import { z } from 'zod';
import type { KnowledgeIndex, SearchHit } from '../../knowledge';
import { defineTool, type ToolDefinition } from '../kernel/types';

export interface DocsDeps {
  index: KnowledgeIndex;
}

/** Excerpt length in characters. Long enough to judge, short enough to scan. */
const EXCERPT_CHARS = 320;

const DEFAULT_SEARCH_LIMIT = 4;

/** Trims a passage to an excerpt, cutting on a word boundary. */
export function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= EXCERPT_CHARS) return collapsed;

  const cut = collapsed.slice(0, EXCERPT_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > EXCERPT_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

function toResult(hit: SearchHit) {
  return {
    chunkId: hit.chunkId,
    document: hit.documentTitle,
    excerpt: excerpt(hit.text),
    // Rounded because the model has no use for more precision, and a long float
    // in the tool result just wastes context.
    relevance: Number(hit.score.toFixed(2)),
  };
}

export function createDocsTools(deps: DocsDeps): ToolDefinition<any, any>[] {
  const { index } = deps;

  const search = defineTool({
    name: 'docs.search',
    description:
      "Search the user's imported documents and return short excerpts with their locations. " +
      'Use this whenever a question might be answered by something the user has saved. ' +
      'Follow up with docs.read using a chunkId to see the full passage.',
    parameters: z.object({
      query: z
        .string()
        .min(2)
        .max(300)
        .describe('What to look for, phrased as the question or topic'),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    scopes: ['read:documents'],
    timeoutMs: 15_000,
    handler: async ({ query, limit }) => {
      const documents = await index.list();
      if (documents.length === 0) {
        // Distinguishing "no documents" from "no matches" matters: the model
        // should tell the user to import something, not that their file has no
        // answer in it.
        return {
          results: [],
          note: 'No documents have been imported yet. Ask the user to add one first.',
        };
      }

      const hits = await index.search(query, limit ?? DEFAULT_SEARCH_LIMIT);
      if (hits.length === 0) {
        return {
          results: [],
          note: `Nothing in the ${documents.length} imported document(s) matches that.`,
        };
      }

      return { results: hits.map(toResult) };
    },
  });

  const read = defineTool({
    name: 'docs.read',
    description:
      'Read the full text of a passage found by docs.search, together with the passages ' +
      'immediately around it. Use this when an excerpt looks relevant but is cut short.',
    parameters: z.object({
      chunkId: z.string().min(1).describe('The chunkId returned by docs.search'),
      radius: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe('How many neighbouring passages to include on each side'),
    }),
    scopes: ['read:documents'],
    timeoutMs: 10_000,
    handler: async ({ chunkId, radius }) => {
      const passages = await index.read(chunkId, radius ?? 1);

      if (passages.length === 0) {
        // A stale chunkId from an earlier turn is common after a document is
        // deleted. Naming the recovery keeps the turn productive.
        return {
          passages: [],
          note: `No passage with id "${chunkId}". Run docs.search again to get current ids.`,
        };
      }

      return {
        document: passages[0].documentTitle,
        passages: passages.map((passage) => ({
          ordinal: passage.ordinal,
          text: passage.text,
        })),
      };
    },
  });

  return [search, read];
}
