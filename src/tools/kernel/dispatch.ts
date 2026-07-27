import type { AuditLog, AuditOutcome } from './audit';
import type { ConsentBroker } from './consent';
import type { ToolRegistry } from './registry';
import type { ToolError, ToolResult } from './types';

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface Dispatcher {
  dispatch(name: string, rawArgs: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

/**
 * Runs one tool call and always resolves.
 *
 * Nothing here throws: a bad tool name, malformed arguments, a refusal, a hang
 * and a crashing handler all come back as a `ToolResult` the model can read and
 * retry from. A tool failure should cost a turn, not the conversation.
 */
export function createDispatcher(deps: {
  registry: ToolRegistry;
  consent: ConsentBroker;
  audit: AuditLog;
  /** Injectable so tests are not at the mercy of the wall clock. */
  now?: () => number;
}): Dispatcher {
  const { registry, consent, audit, now = Date.now } = deps;

  return {
    async dispatch(name, rawArgs, signal) {
      const startedAt = now();
      const finish = (outcome: AuditOutcome, result: ToolResult): ToolResult => {
        audit.record({
          toolName: name,
          args: rawArgs,
          outcome,
          durationMs: result.durationMs,
          at: startedAt,
        });
        return result;
      };
      const fail = (error: ToolError): ToolResult =>
        finish(error.code === 'denied' ? 'denied' : 'error', {
          ok: false,
          name,
          error,
          durationMs: now() - startedAt,
        });

      const tool = registry.get(name);
      if (!tool) {
        const available = registry.list().map((t) => t.name).join(', ');
        return fail({
          code: 'not_found',
          message: `No tool named "${name}". Available tools: ${available || 'none'}.`,
        });
      }

      const parsed = tool.parameters.safeParse(rawArgs);
      if (!parsed.success) {
        // Surface the field-level complaint — small models correct themselves
        // far more reliably from "expected number at .days" than from "invalid".
        const detail = parsed.error.issues
          .map(
            (issue: { path: PropertyKey[]; message: string }) =>
              `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          )
          .join('; ');
        return fail({
          code: 'invalid_args',
          message: `Arguments did not match the schema for "${name}". ${detail}`,
        });
      }

      let permitted: boolean;
      try {
        permitted = await consent.check(tool, parsed.data);
      } catch {
        // A prompt that fails to resolve is treated as refusal. Failing closed
        // is the only safe reading when the user never actually answered.
        permitted = false;
      }
      if (!permitted) {
        return fail({
          code: 'denied',
          message: `The user did not grant permission for "${name}". Do not retry it; continue without it or ask the user directly.`,
        });
      }

      const timeoutMs = tool.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const abortOuter = () => controller.abort();
      signal?.addEventListener('abort', abortOuter, { once: true });
      const timer = setTimeout(abortOuter, timeoutMs);

      try {
        const value = await Promise.race([
          tool.handler(parsed.data, { signal: controller.signal }),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(new DispatchTimeout()),
              { once: true },
            );
          }),
        ]);
        return finish('ok', { ok: true, name, value, durationMs: now() - startedAt });
      } catch (cause) {
        if (cause instanceof DispatchTimeout) {
          return fail({
            code: 'timeout',
            message: `"${name}" did not finish within ${timeoutMs}ms.`,
          });
        }
        return fail({
          code: 'failed',
          message: `"${name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortOuter);
      }
    },
  };
}

class DispatchTimeout extends Error {}
