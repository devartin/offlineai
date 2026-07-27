import type { z } from 'zod';

/**
 * What a tool is allowed to touch, as `action:resource`.
 *
 * Scopes are the unit of user consent — they are what the confirmation sheet
 * names and what the user grants or revokes, never individual tools.
 */
export type PermissionScope = `${'read' | 'write' | 'execute'}:${string}`;

/** Names are dotted and lowercase so they read well in a model prompt. */
const TOOL_NAME = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME.test(name);
}

export interface ToolContext {
  /** Aborts when the turn is cancelled or the dispatch timeout fires. */
  signal: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType, TOut = unknown> {
  name: string;
  /** Written for the model, not the user. Say when to use it, not how it works. */
  description: string;
  parameters: S;
  scopes: readonly PermissionScope[];
  /**
   * Whether the tool changes state the user cares about. Mutating tools are
   * always confirmed with the exact arguments, even under a standing grant —
   * a blanket "always allow" should never silently authorise future writes.
   */
  mutates?: boolean;
  timeoutMs?: number;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<TOut>;
}

/**
 * Identity helper that preserves the schema's generic so `handler` receives
 * fully-typed arguments. Declaring `const t: ToolDefinition = {...}` instead
 * erases the schema and degrades the handler's parameter to `unknown` — so
 * every built-in tool should be written with this.
 */
export function defineTool<S extends z.ZodType, TOut>(
  tool: ToolDefinition<S, TOut>,
): ToolDefinition<S, TOut> {
  return tool;
}

/** The wire shape llama.rn expects in its `tools` array. */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolErrorCode =
  | 'not_found'
  | 'invalid_args'
  | 'denied'
  | 'timeout'
  | 'failed';

export interface ToolError {
  code: ToolErrorCode;
  /** Phrased so the model can recover from it, not so a developer can debug it. */
  message: string;
}

export type ToolResult =
  | { ok: true; name: string; value: unknown; durationMs: number }
  | { ok: false; name: string; error: ToolError; durationMs: number };

/**
 * Renders a result into the string handed back to the model as the tool
 * message. Failures come back as readable text rather than an exception so a
 * broken tool costs one turn instead of the whole conversation.
 */
export function renderToolResult(result: ToolResult): string {
  if (result.ok) {
    return typeof result.value === 'string'
      ? result.value
      : JSON.stringify(result.value ?? null);
  }
  return `Error (${result.error.code}): ${result.error.message}`;
}
