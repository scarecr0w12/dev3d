/**
 * The tool registry: the single place the engine asks "what tools exist" and
 * "what are their schemas". Grants are validated separately by the org engine;
 * the registry just knows names, schemas, and how to run each tool.
 */

import type { ToolSchema } from '@dev3d/core';
import type { Tool, ToolRegistry } from './types.ts';
import { createFsTools } from './fs.ts';
import { createShellTools } from './shell.ts';
import { createWebTools } from './web.ts';
import { createMiscTools } from './misc.ts';

export function createToolRegistry(): ToolRegistry {
  const byName = new Map<string, Tool>();
  return {
    names() {
      return [...byName.keys()];
    },
    get(name) {
      return byName.get(name);
    },
    schemas(names) {
      const out: ToolSchema[] = [];
      for (const name of names) {
        const tool = byName.get(name);
        if (tool) {
          out.push({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          });
        }
      }
      return out;
    },
    register(tool) {
      if (byName.has(tool.name)) {
        throw new Error(`Tool registry already has a tool named "${tool.name}".`);
      }
      byName.set(tool.name, tool);
    },
    unregister(name) {
      return byName.delete(name);
    },
  };
}

export function createDefaultTools(): Tool[] {
  return [...createFsTools(), ...createShellTools(), ...createWebTools(), ...createMiscTools()];
}
