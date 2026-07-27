import type { PermissionScope, ToolDefinition } from './types';

export type GrantState = 'ask' | 'always' | 'never';

export interface ConsentStore {
  get(scope: PermissionScope): GrantState;
  set(scope: PermissionScope, state: GrantState): void;
}

/** What the user chose in the confirmation sheet. */
export type PromptAnswer = 'allow-once' | 'allow-always' | 'deny' | 'deny-always';

export interface PromptRequest {
  tool: ToolDefinition<any, any>;
  /** Shown verbatim so the user approves what the model actually asked for. */
  args: unknown;
  /** Only the scopes not already standing-granted. */
  scopes: PermissionScope[];
}

export interface ConsentBroker {
  check(tool: ToolDefinition<any, any>, args: unknown): Promise<boolean>;
}

export function createInMemoryConsentStore(
  initial: Partial<Record<PermissionScope, GrantState>> = {},
): ConsentStore {
  const grants = new Map<PermissionScope, GrantState>(
    Object.entries(initial) as [PermissionScope, GrantState][],
  );
  return {
    get: (scope) => grants.get(scope) ?? 'ask',
    set: (scope, state) => void grants.set(scope, state),
  };
}

export function createConsentBroker(deps: {
  store: ConsentStore;
  prompt: (request: PromptRequest) => Promise<PromptAnswer>;
}): ConsentBroker {
  const { store, prompt } = deps;

  return {
    async check(tool, args) {
      // A single "never" is disqualifying. Denial is absolute so that revoking
      // a scope cannot be worked around by a tool that spans several.
      if (tool.scopes.some((scope) => store.get(scope) === 'never')) return false;

      const unresolved = tool.scopes.filter((scope) => store.get(scope) !== 'always');

      // Mutating tools always confirm, even fully granted: a standing grant
      // means "don't keep asking to read", never "write whatever you like".
      if (unresolved.length === 0 && !tool.mutates) return true;

      const answer = await prompt({
        tool,
        args,
        scopes: unresolved.length > 0 ? unresolved : [...tool.scopes],
      });

      // Standing grants are only recorded for scopes the user was actually
      // asked about, and never for mutating calls — those stay per-invocation.
      if (answer === 'allow-always' && !tool.mutates) {
        for (const scope of unresolved) store.set(scope, 'always');
      } else if (answer === 'deny-always') {
        for (const scope of tool.scopes) store.set(scope, 'never');
      }

      return answer === 'allow-once' || answer === 'allow-always';
    },
  };
}
