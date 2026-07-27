import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createInMemoryAuditLog } from './audit';
import {
  createConsentBroker,
  createInMemoryConsentStore,
  type PromptAnswer,
  type PromptRequest,
} from './consent';
import { createDispatcher } from './dispatch';
import { createRegistry } from './registry';
import { defineTool, renderToolResult, type ToolDefinition } from './types';

const echoTool = defineTool({
  name: 'echo.say',
  description: 'Repeats a phrase back.',
  parameters: z.object({ phrase: z.string() }),
  scopes: ['read:echo'],
  handler: async ({ phrase }) => phrase,
});

const writeTool = defineTool({
  name: 'notes.write',
  description: 'Appends a note.',
  parameters: z.object({ body: z.string() }),
  scopes: ['write:notes'],
  mutates: true,
  handler: async () => 'written',
});

function harness(
  options: {
    tools?: ToolDefinition<any, any>[];
    answer?: PromptAnswer;
    grants?: Parameters<typeof createInMemoryConsentStore>[0];
  } = {},
) {
  const registry = createRegistry();
  for (const tool of options.tools ?? [echoTool]) registry.register(tool);

  const store = createInMemoryConsentStore(options.grants ?? { 'read:echo': 'always' });
  const prompt = vi.fn(
    async (_request: PromptRequest): Promise<PromptAnswer> =>
      options.answer ?? 'allow-once',
  );
  const audit = createInMemoryAuditLog();

  let tick = 0;
  const dispatcher = createDispatcher({
    registry,
    consent: createConsentBroker({ store, prompt }),
    audit,
    now: () => (tick += 5),
  });

  return { registry, store, prompt, audit, dispatcher };
}

describe('registry', () => {
  it('rejects malformed names, duplicates, and scopeless tools', () => {
    const registry = createRegistry();
    expect(() => registry.register({ ...echoTool, name: 'Echo' })).toThrow(/Invalid tool name/);
    expect(() => registry.register({ ...echoTool, scopes: [] })).toThrow(/at least one scope/);
    registry.register(echoTool);
    expect(() => registry.register(echoTool)).toThrow(/already registered/);
  });

  it('serialises zod parameters to JSON Schema for the model', () => {
    const registry = createRegistry();
    registry.register(echoTool);
    const [spec] = registry.toolSpecs();

    expect(spec.type).toBe('function');
    expect(spec.function.name).toBe('echo.say');
    expect(spec.function.parameters).toMatchObject({
      type: 'object',
      properties: { phrase: { type: 'string' } },
      required: ['phrase'],
    });
  });

  it('hides filtered-out tools entirely', () => {
    const registry = createRegistry();
    registry.register(echoTool);
    registry.register(writeTool);
    expect(registry.toolSpecs((t) => !t.mutates).map((s) => s.function.name)).toEqual([
      'echo.say',
    ]);
  });
});

describe('dispatch', () => {
  it('returns the handler value and audits success', async () => {
    const { dispatcher, audit } = harness();
    const result = await dispatcher.dispatch('echo.say', { phrase: 'hello' });

    expect(result).toMatchObject({ ok: true, name: 'echo.say', value: 'hello' });
    expect(renderToolResult(result)).toBe('hello');
    expect(audit.entries()).toHaveLength(1);
    expect(audit.entries()[0]).toMatchObject({ toolName: 'echo.say', outcome: 'ok' });
  });

  it('reports an unknown tool without throwing, and lists what does exist', async () => {
    const { dispatcher } = harness();
    const result = await dispatcher.dispatch('echo.shout', {});

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: { code: 'not_found' } });
    expect(renderToolResult(result)).toContain('echo.say');
  });

  it('explains which field was wrong so the model can correct itself', async () => {
    const { dispatcher } = harness();
    const result = await dispatcher.dispatch('echo.say', { phrase: 42 });

    expect(result).toMatchObject({ error: { code: 'invalid_args' } });
    expect(renderToolResult(result)).toContain('phrase');
  });

  it('never invokes the handler when consent is refused', async () => {
    const handler = vi.fn();
    const { dispatcher, audit } = harness({
      tools: [{ ...echoTool, handler }],
      grants: { 'read:echo': 'never' },
    });
    const result = await dispatcher.dispatch('echo.say', { phrase: 'hi' });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: { code: 'denied' } });
    expect(audit.entries()[0].outcome).toBe('denied');
  });

  it('fails closed when the consent prompt itself throws', async () => {
    const registry = createRegistry();
    registry.register(echoTool);
    const dispatcher = createDispatcher({
      registry,
      consent: { check: async () => Promise.reject(new Error('sheet dismissed')) },
      audit: createInMemoryAuditLog(),
    });

    expect(await dispatcher.dispatch('echo.say', { phrase: 'hi' })).toMatchObject({
      error: { code: 'denied' },
    });
  });

  it('times out a hanging handler', async () => {
    const { dispatcher } = harness({
      tools: [{ ...echoTool, timeoutMs: 10, handler: () => new Promise(() => {}) }],
    });

    expect(await dispatcher.dispatch('echo.say', { phrase: 'hi' })).toMatchObject({
      error: { code: 'timeout' },
    });
  });

  it('converts a throwing handler into a readable failure', async () => {
    const { dispatcher } = harness({
      tools: [
        {
          ...echoTool,
          handler: async () => {
            throw new Error('calendar unavailable');
          },
        },
      ],
    });
    const result = await dispatcher.dispatch('echo.say', { phrase: 'hi' });

    expect(result).toMatchObject({ error: { code: 'failed' } });
    expect(renderToolResult(result)).toContain('calendar unavailable');
  });

  it('audits every attempt, including the ones that never ran', async () => {
    const { dispatcher, audit } = harness();
    await dispatcher.dispatch('echo.say', { phrase: 'ok' });
    await dispatcher.dispatch('echo.say', { phrase: 7 });
    await dispatcher.dispatch('nope.gone', {});

    expect(audit.entries().map((e) => e.outcome)).toEqual(['ok', 'error', 'error']);
    expect(audit.entries().every((e) => typeof e.at === 'number')).toBe(true);
  });
});

describe('consent', () => {
  it('stops asking once a read scope is granted always', async () => {
    const { dispatcher, prompt } = harness({ answer: 'allow-always', grants: {} });
    await dispatcher.dispatch('echo.say', { phrase: 'a' });
    await dispatcher.dispatch('echo.say', { phrase: 'b' });

    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('re-confirms a mutating tool on every call despite a standing grant', async () => {
    const { dispatcher, prompt } = harness({
      tools: [writeTool],
      grants: { 'write:notes': 'always' },
    });
    await dispatcher.dispatch('notes.write', { body: 'one' });
    await dispatcher.dispatch('notes.write', { body: 'two' });

    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('shows the user the exact arguments the model asked for', async () => {
    const { dispatcher, prompt } = harness({ tools: [writeTool], grants: {} });
    await dispatcher.dispatch('notes.write', { body: 'buy milk' });

    expect(prompt.mock.calls[0][0]).toMatchObject({
      args: { body: 'buy milk' },
      scopes: ['write:notes'],
    });
  });

  it('makes "deny always" stick', async () => {
    const { dispatcher, prompt, store } = harness({ answer: 'deny-always', grants: {} });
    await dispatcher.dispatch('echo.say', { phrase: 'a' });
    expect(store.get('read:echo')).toBe('never');

    const second = await dispatcher.dispatch('echo.say', { phrase: 'b' });
    expect(second).toMatchObject({ error: { code: 'denied' } });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('denies a multi-scope tool if any single scope is revoked', async () => {
    const { dispatcher, prompt } = harness({
      tools: [{ ...echoTool, scopes: ['read:echo', 'read:contacts'] }],
      grants: { 'read:echo': 'always', 'read:contacts': 'never' },
    });

    expect(await dispatcher.dispatch('echo.say', { phrase: 'a' })).toMatchObject({
      error: { code: 'denied' },
    });
    expect(prompt).not.toHaveBeenCalled();
  });
});
