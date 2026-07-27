import { z } from 'zod';
import { isValidToolName, type ToolDefinition, type ToolSpec } from './types';

export interface ToolRegistry {
  register(tool: ToolDefinition<any, any>): void;
  get(name: string): ToolDefinition<any, any> | undefined;
  list(): ToolDefinition<any, any>[];
  /**
   * Serialises to the array llama.rn passes to the model. `only` filters to the
   * tools the current model and consent state actually permit — the model never
   * learns a tool exists unless it is allowed to call it.
   */
  toolSpecs(only?: (tool: ToolDefinition<any, any>) => boolean): ToolSpec[];
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition<any, any>>();

  return {
    register(tool) {
      if (!isValidToolName(tool.name)) {
        throw new Error(
          `Invalid tool name "${tool.name}": expected dotted lowercase, e.g. "calendar.query"`,
        );
      }
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered`);
      }
      if (tool.scopes.length === 0) {
        throw new Error(`Tool "${tool.name}" must declare at least one scope`);
      }
      tools.set(tool.name, tool);
    },

    get: (name) => tools.get(name),

    list: () => [...tools.values()],

    toolSpecs(only) {
      return [...tools.values()]
        .filter((tool) => only?.(tool) ?? true)
        .map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            // `io: 'input'` targets the input side of the schema, which is what
            // the model is being asked to produce.
            parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) as Record<
              string,
              unknown
            >,
          },
        }));
    },
  };
}
