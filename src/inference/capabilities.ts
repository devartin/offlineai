/**
 * Turns raw GGUF metadata into a capability record.
 *
 * This module is the reason the app can promise "tools only appear for models
 * that can actually use them". `loadLlamaModelInfo()` reads GGUF metadata
 * without loading the model into memory, so every judgement here is free and
 * happens before a multi-gigabyte download is even unpacked.
 *
 * Nothing in this file imports React Native or llama.rn — it takes a plain
 * record and returns a plain record, so it is exercised entirely in Node.
 */

/** Raw GGUF key/value metadata, as returned by `loadLlamaModelInfo()`. */
export type GgufMetadata = Record<string, unknown>;

/**
 * The wire format a model emits when it calls a tool.
 *
 * llama.cpp's minja parser handles the actual decoding, but we need the family
 * up front to pick a matching GBNF grammar and to phrase the tool preamble in
 * the dialect the model was trained on.
 */
export type ToolCallStyle =
  | 'hermes' // <tool_call>{...}</tool_call> — Qwen, Hermes, most modern small models
  | 'llama3' // <|python_tag|> or bare JSON with "name"/"parameters"
  | 'mistral' // [TOOL_CALLS][{...}]
  | 'deepseek' // <｜tool▁calls▁begin｜>
  | 'functionary' // >>>tool_name\n{...}
  | 'command-r' // Action: ```json [...] ```
  | 'gemma' // ```tool_code ... ```
  | 'generic' // Template references tools but in no recognised dialect
  | 'none'; // Template has no concept of tools

export interface RamEstimate {
  /** Model weights held resident — effectively the file size. */
  weightsBytes: number;
  /** KV cache at the given context length, f16. Grows linearly with context. */
  kvCacheBytes: number;
  /** Activation and compute scratch buffers. Roughly constant per architecture. */
  overheadBytes: number;
  /** What the process actually needs resident. The number that decides fit. */
  totalBytes: number;
}

export interface ModelCapabilities {
  /** GGUF `general.architecture` — "llama", "qwen3", "gemma3", … */
  architecture: string;
  displayName: string;
  /** Parameters in billions, or null when the metadata does not say. */
  parameterCount: number | null;
  /** Human-readable quantization, e.g. "Q4_K_M". */
  quantization: string;
  /** Maximum context the model was trained for. */
  contextLength: number;
  /**
   * Whether the chat template understands tools at all.
   *
   * This is the single gate for the entire tool subsystem: when false, the
   * tool UI is not rendered, no tool specs are sent, and the model gets a
   * clean chat experience rather than a broken agent.
   */
  supportsTools: boolean;
  toolCallStyle: ToolCallStyle;
  /**
   * Whether the template can render prior tool results back to the model.
   * A model can emit a call without this, but cannot carry a multi-step
   * conversation — so it caps us at one tool per turn.
   */
  supportsToolResults: boolean;
  supportsVision: boolean;
  /** Pooling-only models (EmbeddingGemma and friends) — never used for chat. */
  isEmbeddingModel: boolean;
  /** Emits <think>…</think> or equivalent, which the UI collapses by default. */
  supportsReasoning: boolean;
  hasChatTemplate: boolean;
  estimatedRam: RamEstimate;
}

/**
 * GGUF `general.file_type` enum → quantization name.
 *
 * From llama.cpp's `llama_ftype`. Only the values that appear on real
 * distributed models are listed; anything else falls back to filename parsing.
 */
const FILE_TYPE_NAMES: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  36: 'TQ1_0',
  37: 'TQ2_0',
};

/**
 * Signature strings that identify a tool-call dialect, most specific first.
 *
 * Order matters: DeepSeek's template also contains `<tool_call>`-like markup,
 * so its distinctive fullwidth delimiters have to be tested before the generic
 * Hermes tag.
 */
const STYLE_SIGNATURES: ReadonlyArray<readonly [ToolCallStyle, RegExp]> = [
  ['deepseek', /<｜tool▁calls▁begin｜>|<｜tool▁call▁begin｜>/],
  ['mistral', /\[TOOL_CALLS\]/],
  ['llama3', /<\|python_tag\|>/],
  ['command-r', /Action:\s*```json|<\|START_ACTION\|>/],
  ['gemma', /```tool_code|```tool_outputs/],
  ['hermes', /<tool_call>/],
  ['functionary', />>>/],
];

function readString(metadata: GgufMetadata, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(metadata: GgufMetadata, key: string): number | undefined {
  const value = metadata[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // llama.rn surfaces some numeric metadata as strings depending on the
  // underlying GGUF value type, so coerce rather than discard.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readBoolean(metadata: GgufMetadata, key: string): boolean {
  const value = metadata[key];
  return value === true || value === 'true' || value === 1;
}

/**
 * Reads an architecture-scoped key.
 *
 * GGUF namespaces most structural metadata under the architecture name —
 * `qwen3.context_length`, `llama.block_count` — so every lookup needs the
 * architecture prefix rather than a fixed key.
 */
function readArchNumber(
  metadata: GgufMetadata,
  architecture: string,
  suffix: string,
): number | undefined {
  return readNumber(metadata, `${architecture}.${suffix}`);
}

/**
 * Detects whether a Jinja chat template understands tools.
 *
 * The signal is a reference to a bare `tools` identifier inside a Jinja
 * expression or statement — that is exactly what llama.cpp's chat-format
 * autoparser keys on. `\btools\b` cannot collide with `tool_calls` because a
 * `_` follows `tool` there, so the two checks stay independent.
 */
function templateReferencesTools(template: string): boolean {
  return /\{[%{][^%}]*\btools\b/.test(template);
}

function templateReferencesToolResults(template: string): boolean {
  // Either the template renders assistant tool_calls back, or it handles a
  // message with role == "tool". Both are required for multi-turn tool use.
  return (
    /\btool_calls\b/.test(template) ||
    /role\s*==\s*['"]tool['"]/.test(template) ||
    /['"]tool['"]\s*==\s*\w*role/.test(template)
  );
}

function detectToolCallStyle(template: string): ToolCallStyle {
  for (const [style, signature] of STYLE_SIGNATURES) {
    if (signature.test(template)) return style;
  }
  return 'generic';
}

/**
 * Parses a parameter count from a size label like "3B", "1.5B", "270M".
 * Returns billions so 270M becomes 0.27.
 */
function parseSizeLabel(label: string | undefined): number | null {
  if (!label) return null;
  const match = /^([\d.]+)\s*([BMK])/i.exec(label.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toUpperCase();
  if (unit === 'B') return value;
  if (unit === 'M') return value / 1000;
  return value / 1_000_000;
}

/** Recovers a quantization name from a filename when metadata is unhelpful. */
function parseQuantFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const match = /\b(IQ\d[A-Z_]*|Q\d_[A-Z0-9_]+|Q\d|BF16|F16|F32)\b/i.exec(name);
  return match ? match[1].toUpperCase() : undefined;
}

/**
 * Estimates resident memory for a given context length.
 *
 * The KV cache is the term that actually varies with product decisions, so it
 * is computed from real architecture metadata rather than a fudge factor:
 *
 *   bytes = 2 (K and V) x layers x kv_heads x head_dim x context x 2 (f16)
 *
 * Grouped-query attention makes `kv_heads` much smaller than `head_count` on
 * modern small models, which is exactly why a 4B model with GQA fits where an
 * older 3B model would not.
 */
export function estimateRam(
  metadata: GgufMetadata,
  architecture: string,
  fileSizeBytes: number,
  contextLength: number,
): RamEstimate {
  const layers = readArchNumber(metadata, architecture, 'block_count') ?? 32;
  const embeddingLength =
    readArchNumber(metadata, architecture, 'embedding_length') ?? 4096;
  const headCount =
    readArchNumber(metadata, architecture, 'attention.head_count') ?? 32;
  const kvHeadCount =
    readArchNumber(metadata, architecture, 'attention.head_count_kv') ?? headCount;

  // Prefer an explicit head dimension when the architecture publishes one —
  // some models (Gemma 3) decouple it from embedding_length / head_count.
  const headDim =
    readArchNumber(metadata, architecture, 'attention.key_length') ??
    Math.floor(embeddingLength / Math.max(headCount, 1));

  const kvCacheBytes = 2 * layers * kvHeadCount * headDim * contextLength * 2;

  // Compute scratch scales with the widest tensor the graph materialises, which
  // tracks embedding width and layer count. The constant is calibrated against
  // observed llama.cpp allocations rather than derived.
  const overheadBytes = Math.round(embeddingLength * layers * 1024 + 96 * 1024 * 1024);

  return {
    weightsBytes: fileSizeBytes,
    kvCacheBytes,
    overheadBytes,
    totalBytes: fileSizeBytes + kvCacheBytes + overheadBytes,
  };
}

export interface DescribeOptions {
  /** Size of the GGUF file on disk. Dominates the memory estimate. */
  fileSizeBytes?: number;
  /**
   * Context length to size the KV cache against. Defaults to the model's
   * trained maximum, which is usually far more than a phone should allocate —
   * callers pass the context they actually intend to open.
   */
  contextLength?: number;
  /** Filename, used to recover quantization when metadata omits it. */
  fileName?: string;
  /**
   * Whether a matching mmproj projector file is present. Vision is a property
   * of the model *pair*, so metadata alone cannot answer it.
   */
  hasProjector?: boolean;
}

/** Architectures whose GGUF exports are pooling-only embedding models. */
const EMBEDDING_ARCHITECTURES = new Set([
  'bert',
  'nomic-bert',
  'jina-bert-v2',
  'gemma-embedding',
  't5encoder',
]);

/**
 * Architectures that emit explicit reasoning traces the UI should collapse.
 * Detected structurally where possible; this list covers models whose template
 * hides the marker behind a variable.
 */
const REASONING_ARCHITECTURES = new Set(['deepseek2', 'qwen3', 'qwen3moe']);

/**
 * Builds the capability record that gates every downstream feature.
 *
 * Deliberately total: unknown or malformed metadata yields a conservative
 * record rather than throwing. A model we cannot understand should degrade to
 * plain chat, never to a crash on the download screen.
 */
export function describeModel(
  metadata: GgufMetadata,
  options: DescribeOptions = {},
): ModelCapabilities {
  const architecture = readString(metadata, 'general.architecture') ?? 'unknown';
  const template = readString(metadata, 'tokenizer.chat_template');
  const hasChatTemplate = template !== undefined;

  const isEmbeddingModel =
    EMBEDDING_ARCHITECTURES.has(architecture) ||
    readBoolean(metadata, 'general.embedding_only') ||
    // A chat model always ships a chat template. Its absence alongside an
    // explicit pooling type is the clearest signal that this is an encoder.
    (!hasChatTemplate &&
      readArchNumber(metadata, architecture, 'pooling_type') !== undefined);

  const supportsTools =
    !isEmbeddingModel && template !== undefined && templateReferencesTools(template);

  const trainedContext =
    readArchNumber(metadata, architecture, 'context_length') ??
    readNumber(metadata, 'llama.context_length') ??
    2048;
  const contextLength = options.contextLength ?? trainedContext;

  const fileType = readNumber(metadata, 'general.file_type');
  const quantization =
    (fileType !== undefined ? FILE_TYPE_NAMES[fileType] : undefined) ??
    parseQuantFromName(options.fileName) ??
    parseQuantFromName(readString(metadata, 'general.name')) ??
    'unknown';

  const parameterCount =
    parseSizeLabel(readString(metadata, 'general.size_label')) ??
    (() => {
      const raw = readNumber(metadata, 'general.parameter_count');
      return raw !== undefined ? raw / 1e9 : null;
    })();

  const supportsVision =
    options.hasProjector === true ||
    readBoolean(metadata, 'clip.has_vision_encoder') ||
    readNumber(metadata, `${architecture}.vision.block_count`) !== undefined;

  const supportsReasoning =
    REASONING_ARCHITECTURES.has(architecture) ||
    (template !== undefined && /<think>|<\|thinking\|>|◁think▷/.test(template));

  return {
    architecture,
    displayName:
      readString(metadata, 'general.basename') ??
      readString(metadata, 'general.name') ??
      options.fileName ??
      'Unknown model',
    parameterCount,
    quantization,
    contextLength: trainedContext,
    supportsTools,
    toolCallStyle: supportsTools ? detectToolCallStyle(template!) : 'none',
    supportsToolResults:
      supportsTools && template !== undefined && templateReferencesToolResults(template),
    supportsVision,
    isEmbeddingModel,
    supportsReasoning,
    hasChatTemplate,
    estimatedRam: estimateRam(
      metadata,
      architecture,
      options.fileSizeBytes ?? 0,
      contextLength,
    ),
  };
}
