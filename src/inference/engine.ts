/**
 * The inference runtime: one loaded model, and the turn loop that drives it.
 *
 * Two responsibilities live here because they are inseparable in practice —
 * the turn loop needs to know whether the context is still resident, and the
 * lifecycle needs to know whether a turn is mid-flight before it evicts.
 *
 * The hard constraint shaping this file is memory. iOS jetsam kills the app
 * holding the largest allocation first, and a loaded 4B model is by far the
 * largest thing this process owns. So the context is treated as disposable:
 * evicted on background, restored from a saved session on return, and never
 * assumed to still exist.
 */

import type {
  ContextParams,
  LlamaContext,
  RNLlamaOAICompatibleMessage,
  TokenData,
  ToolCall,
} from 'llama.rn';
import type { Dispatcher } from '../tools/kernel/dispatch';
import { renderToolResult, type ToolSpec } from '../tools/kernel/types';
import { describeModel, type GgufMetadata, type ModelCapabilities } from './capabilities';

/**
 * The native surface this module needs from llama.rn.
 *
 * Everything else llama.rn exports is used as a type only, and types are erased
 * at runtime — so this is the entire runtime dependency.
 */
interface LlamaNative {
  initLlama: (
    params: ContextParams,
    onProgress?: (progress: number) => void,
  ) => Promise<LlamaContext>;
  loadLlamaModelInfo: (model: string) => Promise<object>;
  releaseAllLlama: () => Promise<void>;
}

let cached: LlamaNative | null = null;
let unavailableReason: string | null = null;

/**
 * Resolves llama.rn lazily.
 *
 * A static import would execute the native module at app startup, which throws
 * in any JS-only host — Expo Go, a web preview, a Node test. Deferring it means
 * the whole app boots and renders everywhere, and only the parts that genuinely
 * need inference fail, with an explanation.
 *
 * This is not merely a convenience for previewing: the same path is what lets
 * the UI, model catalog and tool kernel be exercised without a native build.
 */
function native(): LlamaNative {
  if (cached) return cached;
  if (unavailableReason) throw new Error(unavailableReason);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('llama.rn') as Partial<LlamaNative>;

    // Loading the JS is not proof of a native binding. In a JS-only host the
    // module can import cleanly and only fail later, deep inside a load — so
    // the exports are checked here, where the failure is still explainable.
    if (
      typeof loaded.initLlama !== 'function' ||
      typeof loaded.loadLlamaModelInfo !== 'function'
    ) {
      throw new Error('llama.rn loaded without its native binding');
    }

    cached = loaded as LlamaNative;
    return cached;
  } catch (cause) {
    unavailableReason =
      'On-device inference is unavailable in this environment. ' +
      'llama.rn is a native module, so it needs a development build rather than Expo Go. ' +
      `(${cause instanceof Error ? cause.message : String(cause)})`;
    throw new Error(unavailableReason);
  }
}

/**
 * Whether this environment can actually run a model.
 *
 * The UI branches on this so a user in Expo Go sees an honest explanation
 * instead of a crash or a permanently spinning loader.
 */
export function isInferenceAvailable(): boolean {
  if (cached) return true;
  if (unavailableReason) return false;
  try {
    native();
    return true;
  } catch {
    return false;
  }
}

/** Why inference is unavailable, or null when it is available. */
export function inferenceUnavailableReason(): string | null {
  isInferenceAvailable();
  return unavailableReason;
}

export interface LoadRequest {
  modelPath: string;
  /** Multimodal projector, when the model has one. Enables `vision.*` tools. */
  mmprojPath?: string;
  contextLength: number;
  /**
   * Where to persist the KV cache when the app backgrounds. Restoring from
   * this is what makes eviction invisible to the user.
   */
  sessionPath?: string;
}

export interface LoadedModel {
  context: LlamaContext;
  capabilities: ModelCapabilities;
  contextLength: number;
  modelPath: string;
  mmprojPath?: string;
  sessionPath?: string;
  /** True when a GPU backend actually engaged — Metal, OpenCL or Vulkan. */
  gpuAccelerated: boolean;
}

export type EngineState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number; modelPath: string }
  | { status: 'ready'; model: LoadedModel }
  | { status: 'evicted'; request: LoadRequest; capabilities: ModelCapabilities }
  | { status: 'error'; message: string };

/**
 * Reads a GGUF's capabilities without loading it.
 *
 * This is what makes capability gating free: the metadata read costs
 * milliseconds and no meaningful memory, so the UI can describe a model long
 * before anyone decides to run it.
 */
export async function inspectModel(
  modelPath: string,
  options: {
    fileSizeBytes?: number;
    contextLength?: number;
    hasProjector?: boolean;
  } = {},
): Promise<ModelCapabilities> {
  const metadata = (await native().loadLlamaModelInfo(modelPath)) as GgufMetadata;
  return describeModel(metadata, {
    ...options,
    fileName: modelPath.split('/').pop(),
  });
}

/**
 * How many GPU layers to offload.
 *
 * 99 means "all of them" to llama.cpp. On mobile the choice is effectively
 * binary — partial offload costs more in host/device transfer than it saves in
 * compute — so we ask for everything and let the backend decline.
 */
const GPU_LAYERS = 99;

export interface Engine {
  getState(): EngineState;
  subscribe(listener: (state: EngineState) => void): () => void;
  load(request: LoadRequest, onProgress?: (progress: number) => void): Promise<LoadedModel>;
  /** Releases the context but remembers how to rebuild it. */
  evict(): Promise<void>;
  /** Rebuilds an evicted context, restoring its saved KV cache if one exists. */
  restore(): Promise<LoadedModel | null>;
  unload(): Promise<void>;
  /** Resolves once any in-flight turn has finished. */
  idle(): Promise<void>;
  /**
   * Runs a turn against the loaded model, tracking it so `evict` and `unload`
   * cannot release the context mid-completion.
   */
  run(
    messages: ChatMessage[],
    deps: { dispatcher: Dispatcher; toolSpecs: ToolSpec[] },
    events?: TurnEvents,
    options?: TurnOptions,
  ): Promise<TurnResult>;
  embed(text: string): Promise<Float32Array>;
}

export function createEngine(): Engine {
  let state: EngineState = { status: 'idle' };
  const listeners = new Set<(state: EngineState) => void>();

  /**
   * The in-flight turn, so eviction can wait for it. Releasing a context
   * mid-completion crashes the native side, so this is load-bearing.
   */
  let inFlight: Promise<unknown> | null = null;

  function setState(next: EngineState): void {
    state = next;
    for (const listener of listeners) listener(next);
  }

  function requireReady(): LoadedModel {
    if (state.status !== 'ready') {
      throw new Error(`No model is loaded (engine is "${state.status}")`);
    }
    return state.model;
  }

  async function build(
    request: LoadRequest,
    onProgress?: (progress: number) => void,
  ): Promise<LoadedModel> {
    const params: ContextParams = {
      model: request.modelPath,
      n_ctx: request.contextLength,
      n_gpu_layers: GPU_LAYERS,
      // Leaving one core free keeps the UI thread responsive during prefill,
      // which is where the app feels slowest.
      n_threads: Math.max(2, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1),
      // mlock would pin pages and make the app a bigger jetsam target for no
      // benefit — the OS page cache already keeps hot weights resident.
      use_mlock: false,
    };

    const context = await native().initLlama(params, (progress) => {
      setState({ status: 'loading', progress, modelPath: request.modelPath });
      onProgress?.(progress);
    });

    const capabilities = await inspectModel(request.modelPath, {
      contextLength: request.contextLength,
      hasProjector: request.mmprojPath !== undefined,
    });

    if (request.mmprojPath) {
      // A projector that fails to load is not fatal — the model still chats,
      // it just loses vision. Downgrading beats refusing to start.
      try {
        await context.initMultimodal({ path: request.mmprojPath, use_gpu: true });
      } catch {
        capabilities.supportsVision = false;
      }
    }

    return {
      context,
      capabilities,
      contextLength: request.contextLength,
      modelPath: request.modelPath,
      mmprojPath: request.mmprojPath,
      sessionPath: request.sessionPath,
      gpuAccelerated: context.gpu,
    };
  }

  async function idle(): Promise<void> {
    while (inFlight) {
      const pending = inFlight;
      await pending.catch(() => undefined);
      if (inFlight === pending) inFlight = null;
    }
  }

  const engine: Engine = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async load(request, onProgress) {
      if (state.status === 'ready') await engine.unload();
      setState({ status: 'loading', progress: 0, modelPath: request.modelPath });

      try {
        const model = await build(request, onProgress);
        setState({ status: 'ready', model });
        return model;
      } catch (cause) {
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    },

    async evict() {
      if (state.status !== 'ready') return;
      const { model } = state;

      await idle();

      // Persist the KV cache first. If this fails the eviction still proceeds —
      // a slower restore is far better than being killed for holding memory.
      if (model.sessionPath) {
        try {
          await model.context.saveSession(model.sessionPath, { tokenSize: -1 });
        } catch {
          // Session persistence is an optimisation, never a correctness
          // requirement: a missing session only means a cold prefill.
        }
      }

      await model.context.release();
      setState({
        status: 'evicted',
        capabilities: model.capabilities,
        request: {
          modelPath: model.modelPath,
          mmprojPath: model.mmprojPath,
          contextLength: model.contextLength,
          sessionPath: model.sessionPath,
        },
      });
    },

    async restore() {
      if (state.status === 'ready') return state.model;
      if (state.status !== 'evicted') return null;

      const { request } = state;
      const model = await build(request);

      if (request.sessionPath) {
        try {
          await model.context.loadSession(request.sessionPath);
        } catch {
          // A stale or corrupt session file only costs a re-prefill.
        }
      }

      setState({ status: 'ready', model });
      return model;
    },

    async unload() {
      if (state.status === 'ready') {
        await idle();
        await state.model.context.release();
      }
      // Guarded because unload is also called on teardown paths where a model
      // was never loaded — and where the native module may not exist at all.
      if (cached) await cached.releaseAllLlama();
      setState({ status: 'idle' });
    },

    idle,

    async run(messages, deps, events, options) {
      const model = requireReady();
      const turn = runTurn(model, messages, deps, events, options);
      inFlight = turn;
      try {
        return await turn;
      } finally {
        if (inFlight === turn) inFlight = null;
      }
    },

    async embed(text) {
      const model = requireReady();
      const result = await model.context.embedding(text);
      return new Float32Array(result.embedding);
    },
  };

  return engine;
}

// ---------------------------------------------------------------------------
// The turn loop
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant messages that called tools. */
  toolCalls?: ToolCall[];
  /** Present on tool messages, linking the result to its call. */
  toolCallId?: string;
}

export interface TurnEvents {
  /** Fires for every content token. Reasoning tokens arrive separately. */
  onToken?: (token: string) => void;
  /** Fires for tokens inside a reasoning block, so the UI can collapse them. */
  onReasoningToken?: (token: string) => void;
  /** Fires when the model has decided to call a tool, before it runs. */
  onToolCall?: (name: string, args: unknown) => void;
  /** Fires with the rendered result once a tool has run. */
  onToolResult?: (name: string, ok: boolean, rendered: string) => void;
}

export interface TurnOptions {
  temperature?: number;
  maxTokens?: number;
  /**
   * Hard ceiling on tool round-trips within one user turn.
   *
   * Small models get stuck in call loops — asking the same tool repeatedly
   * because they cannot tell they already have the answer. This is the backstop
   * that keeps a bad turn cheap.
   */
  maxToolRounds?: number;
  signal?: AbortSignal;
}

export interface ToolRun {
  name: string;
  args: unknown;
  ok: boolean;
  rendered: string;
}

export interface TurnResult {
  content: string;
  reasoning: string | null;
  /** Every tool that ran, in order, for the audit trail and the transcript. */
  toolRuns: ToolRun[];
  /** True when the round cap cut the turn short rather than the model finishing. */
  stoppedEarly: boolean;
}

const DEFAULT_MAX_TOOL_ROUNDS = 5;

/**
 * Runs one user turn to completion, including any tool round-trips.
 *
 * The capability record decides the shape of the turn:
 *   - no tool support        -> a single plain completion, no `tools` sent
 *   - tools, no result slot  -> one call, then a forced final answer
 *   - full support           -> loop until the model answers or hits the cap
 *
 * That branching is the whole point of capability detection. A model whose
 * template cannot render tool results produces garbage if you feed them back,
 * so it gets a different loop rather than a broken one.
 */
export async function runTurn(
  model: LoadedModel,
  messages: ChatMessage[],
  deps: { dispatcher: Dispatcher; toolSpecs: ToolSpec[] },
  events: TurnEvents = {},
  options: TurnOptions = {},
): Promise<TurnResult> {
  const { capabilities, context } = model;
  const useTools = capabilities.supportsTools && deps.toolSpecs.length > 0;
  const maxRounds = capabilities.supportsToolResults
    ? (options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS)
    : 1;

  const history: ChatMessage[] = [...messages];
  const toolRuns: ToolRun[] = [];

  let content = '';
  let reasoning = '';
  let stoppedEarly = false;

  for (let round = 0; round <= maxRounds; round++) {
    if (options.signal?.aborted) {
      stoppedEarly = true;
      break;
    }

    // On the final permitted round, withhold the tools entirely. Leaving them
    // available invites another call the loop has no budget to service, which
    // the user would see as a turn that ends mid-thought.
    const offerTools = useTools && round < maxRounds;

    content = '';
    reasoning = '';

    const abortListener = () => void context.stopCompletion();
    options.signal?.addEventListener('abort', abortListener, { once: true });

    let result;
    try {
      result = await context.completion(
        {
          messages: history as unknown as RNLlamaOAICompatibleMessage[],
          jinja: true,
          ...(offerTools ? { tools: deps.toolSpecs, tool_choice: 'auto' } : {}),
          n_predict: options.maxTokens ?? 1024,
          temperature: options.temperature ?? 0.7,
        },
        (data: TokenData) => {
          if (data.reasoning_content) {
            reasoning += data.reasoning_content;
            events.onReasoningToken?.(data.reasoning_content);
          }
          if (data.content) {
            content += data.content;
            events.onToken?.(data.content);
          }
        },
      );
    } finally {
      options.signal?.removeEventListener('abort', abortListener);
    }

    // llama.cpp's parser reports the assembled call; the streamed deltas above
    // are only for display, so the authoritative list comes from the result.
    const calls = (result.tool_calls ?? []) as ToolCall[];
    if (!offerTools || calls.length === 0) {
      content = result.content ?? content;
      break;
    }

    history.push({
      role: 'assistant',
      content: result.content ?? '',
      toolCalls: calls,
    });

    // One tool per round, deliberately. Small models that emit several calls at
    // once are usually guessing, and running them all multiplies the damage a
    // wrong guess can do.
    const call = calls[0];
    const args = parseArguments(call.function.arguments);
    events.onToolCall?.(call.function.name, args);

    const dispatched = await deps.dispatcher.dispatch(
      call.function.name,
      args,
      options.signal,
    );
    const rendered = renderToolResult(dispatched);

    toolRuns.push({ name: call.function.name, args, ok: dispatched.ok, rendered });
    events.onToolResult?.(call.function.name, dispatched.ok, rendered);

    history.push({
      role: 'tool',
      content: rendered,
      toolCallId: call.id ?? call.function.name,
    });

    if (round === maxRounds - 1) stoppedEarly = true;
  }

  return {
    content: content.trim(),
    reasoning: reasoning.trim() || null,
    toolRuns,
    stoppedEarly,
  };
}

/**
 * Parses tool arguments, which arrive as a JSON string.
 *
 * Malformed JSON becomes an empty object rather than an exception: the
 * dispatcher's schema validation then rejects it and hands the model a
 * specific, actionable error, which is a far better recovery path than a
 * thrown turn.
 */
function parseArguments(raw: string): unknown {
  if (!raw || raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
