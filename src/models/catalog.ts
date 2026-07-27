/**
 * The curated model catalog.
 *
 * Curation is the product here. Hugging Face has tens of thousands of GGUF
 * files and most of them will disappoint on a phone — wrong quantization,
 * broken chat template, no GQA, or a licence that forbids redistribution. This
 * list is the set we are prepared to stand behind, ordered so the first thing
 * a user sees is something that will work on their device.
 *
 * `toolGrade` is deliberately `unmeasured` for every entry until the eval
 * harness produces a real number. Publishing a guess would defeat the point of
 * having the harness at all.
 */

import { z } from 'zod';

/**
 * How reliably a model uses tools, from the eval harness.
 *
 * Grades come from measured pass rates over the scenario suite, never from
 * reputation or parameter count — small models surprise in both directions.
 */
export const ToolGrade = z.enum([
  'excellent', // >=90% of scenarios, including multi-step
  'good', // >=75%, reliable for single-tool turns
  'fair', // >=50%, usable with grammar constraint
  'poor', // <50%, tools are offered but warned about
  'none', // Chat template has no tool support
  'unmeasured', // Not yet run through the harness
]);
export type ToolGrade = z.infer<typeof ToolGrade>;

export const CatalogEntry = z.object({
  /** Stable slug. Used as the on-disk directory name — never change it. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  /** One line, shown under the name. Say what it is good at. */
  blurb: z.string(),
  /** Hugging Face repo, `owner/name`. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /** Filename within the repo. */
  file: z.string().endsWith('.gguf'),
  /**
   * Companion multimodal projector, when the model supports vision. Downloaded
   * alongside the weights; its presence is what flips `supportsVision`.
   */
  mmprojFile: z.string().endsWith('.gguf').optional(),
  sizeBytes: z.number().int().positive(),
  /** Parameters in billions. */
  params: z.number().positive(),
  quant: z.string(),
  /** SPDX-style identifier. Shown before download so the user knows what they get. */
  license: z.string(),
  toolGrade: ToolGrade,
  /**
   * Context to open by default. Almost always far below the trained maximum —
   * a 128k-capable model given 128k of KV cache will not fit on any phone.
   */
  defaultContext: z.number().int().positive(),
  tags: z.array(z.enum(['tools', 'vision', 'reasoning', 'embedding', 'tiny', 'coding'])),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

/**
 * Curated models, roughly ascending by memory footprint.
 *
 * Sizes are the published GGUF file sizes; they are verified against the
 * `Content-Length` at download time, and a mismatch aborts rather than
 * silently writing a truncated file.
 */
export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'gemma-3-270m-it',
    name: 'Gemma 3 270M',
    blurb: 'Smallest useful model. Instant replies on any phone; no tool support.',
    repo: 'ggml-org/gemma-3-270m-it-GGUF',
    file: 'gemma-3-270m-it-Q8_0.gguf',
    sizeBytes: 292_000_000,
    params: 0.27,
    quant: 'Q8_0',
    license: 'gemma',
    toolGrade: 'none',
    defaultContext: 4096,
    tags: ['tiny'],
  },
  {
    id: 'qwen3-0-6b',
    name: 'Qwen3 0.6B',
    blurb: 'Tiny but tool-capable. The smallest model here that can run tools.',
    repo: 'Qwen/Qwen3-0.6B-GGUF',
    file: 'Qwen3-0.6B-Q4_K_M.gguf',
    sizeBytes: 484_000_000,
    params: 0.6,
    quant: 'Q4_K_M',
    license: 'apache-2.0',
    toolGrade: 'unmeasured',
    defaultContext: 8192,
    tags: ['tools', 'reasoning', 'tiny'],
  },
  {
    id: 'llama-3-2-1b-instruct',
    name: 'Llama 3.2 1B',
    blurb: 'Fast and even-tempered. Good default for older or 4GB devices.',
    repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
    file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    sizeBytes: 808_000_000,
    params: 1.24,
    quant: 'Q4_K_M',
    license: 'llama3.2',
    toolGrade: 'unmeasured',
    defaultContext: 8192,
    tags: ['tools'],
  },
  {
    id: 'qwen3-1-7b',
    name: 'Qwen3 1.7B',
    blurb: 'Strong reasoning for its size. Solid all-rounder on 6GB phones.',
    repo: 'Qwen/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    sizeBytes: 1_120_000_000,
    params: 1.7,
    quant: 'Q4_K_M',
    license: 'apache-2.0',
    toolGrade: 'unmeasured',
    defaultContext: 8192,
    tags: ['tools', 'reasoning'],
  },
  {
    id: 'llama-3-2-3b-instruct',
    name: 'Llama 3.2 3B',
    blurb: 'Reliable instruction following. A dependable everyday choice.',
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 2_020_000_000,
    params: 3.21,
    quant: 'Q4_K_M',
    license: 'llama3.2',
    toolGrade: 'unmeasured',
    defaultContext: 8192,
    tags: ['tools'],
  },
  {
    id: 'qwen2-5-coder-3b',
    name: 'Qwen2.5 Coder 3B',
    blurb: 'Built for code. Pairs well with the sandboxed JavaScript tool.',
    repo: 'Qwen/Qwen2.5-Coder-3B-Instruct-GGUF',
    file: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    sizeBytes: 2_100_000_000,
    params: 3.09,
    quant: 'Q4_K_M',
    license: 'apache-2.0',
    toolGrade: 'unmeasured',
    defaultContext: 8192,
    tags: ['tools', 'coding'],
  },
  {
    id: 'gemma-3-4b-it',
    name: 'Gemma 3 4B',
    blurb: 'Sees images. Pair with the projector for photo and document questions.',
    repo: 'ggml-org/gemma-3-4b-it-GGUF',
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
    mmprojFile: 'mmproj-model-f16.gguf',
    sizeBytes: 2_490_000_000,
    params: 4.3,
    quant: 'Q4_K_M',
    license: 'gemma',
    toolGrade: 'none',
    defaultContext: 4096,
    tags: ['vision'],
  },
  {
    id: 'phi-4-mini-instruct',
    name: 'Phi-4 Mini',
    blurb: 'Punches above its weight on maths and structured reasoning.',
    repo: 'bartowski/microsoft_Phi-4-mini-instruct-GGUF',
    file: 'microsoft_Phi-4-mini-instruct-Q4_K_M.gguf',
    sizeBytes: 2_490_000_000,
    params: 3.84,
    quant: 'Q4_K_M',
    license: 'mit',
    toolGrade: 'unmeasured',
    defaultContext: 8192,
    tags: ['tools', 'coding'],
  },
  {
    id: 'qwen3-4b-instruct',
    name: 'Qwen3 4B Instruct',
    blurb: 'The recommended default on 8GB phones. Best tool use for its size.',
    repo: 'Qwen/Qwen3-4B-Instruct-2507-GGUF',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sizeBytes: 2_500_000_000,
    params: 4.02,
    quant: 'Q4_K_M',
    license: 'apache-2.0',
    toolGrade: 'unmeasured',
    defaultContext: 8192,
    tags: ['tools', 'reasoning'],
  },
  {
    id: 'deepseek-r1-distill-qwen-1-5b',
    name: 'DeepSeek-R1 Distill 1.5B',
    blurb: 'Thinks step by step before answering. Slower, but shows its working.',
    repo: 'bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF',
    file: 'DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf',
    sizeBytes: 1_120_000_000,
    params: 1.78,
    quant: 'Q4_K_M',
    license: 'mit',
    toolGrade: 'unmeasured',
    defaultContext: 8192,
    tags: ['reasoning'],
  },
  {
    id: 'ministral-8b-instruct',
    name: 'Ministral 8B',
    blurb: 'Flagship phones only. The most capable model that will still load.',
    repo: 'bartowski/Ministral-8B-Instruct-2410-GGUF',
    file: 'Ministral-8B-Instruct-2410-Q4_K_M.gguf',
    sizeBytes: 4_910_000_000,
    params: 8.02,
    quant: 'Q4_K_M',
    license: 'mrl',
    toolGrade: 'unmeasured',
    defaultContext: 4096,
    tags: ['tools'],
  },
  {
    id: 'embeddinggemma-300m',
    name: 'EmbeddingGemma 300M',
    blurb: 'Powers document search. Installed automatically when you add files.',
    repo: 'ggml-org/embeddinggemma-300m-GGUF',
    file: 'embeddinggemma-300m-Q8_0.gguf',
    sizeBytes: 320_000_000,
    params: 0.3,
    quant: 'Q8_0',
    license: 'gemma',
    toolGrade: 'none',
    defaultContext: 2048,
    tags: ['embedding'],
  },
];

/**
 * The embedding model the knowledge index depends on.
 *
 * Held as a named export because ingestion needs to install it on demand
 * rather than asking the user to find it in a list.
 */
export const EMBEDDING_MODEL_ID = 'embeddinggemma-300m';

export function findEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

/** Chat-capable models only — excludes encoders that cannot hold a conversation. */
export function chatModels(): CatalogEntry[] {
  return CATALOG.filter((entry) => !entry.tags.includes('embedding'));
}

/** Direct download URL for a file in a catalog entry's repo. */
export function downloadUrl(entry: CatalogEntry, file: string): string {
  return `https://huggingface.co/${entry.repo}/resolve/main/${file}?download=true`;
}

/**
 * Validates every catalog entry against the schema.
 *
 * A malformed entry is a build-time mistake, and failing loudly in a test beats
 * a confusing render failure three screens deep in the model manager.
 */
export function validateCatalog(): void {
  const seen = new Set<string>();
  for (const entry of CATALOG) {
    CatalogEntry.parse(entry);
    if (seen.has(entry.id)) throw new Error(`Duplicate catalog id: ${entry.id}`);
    seen.add(entry.id);
  }
}
