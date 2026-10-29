import { tool, Tool } from "ai";
import { Sandbox } from "./sandbox";
import { Skill } from "./skill";
import {
  createAskUserTool,
  createBashTool,
  createGrepTool,
  createLoadSkillTool,
  createReadTool,
  createTaskTool,
  createTodoTool,
} from "./tools";
import { createApproval } from "./index";

const SAFE_PREFIXES = [
  "ls",
  "cat",
  "echo",
  "pwd",
  "which",
  "find",
  "head",
  "tail",
  "wc",
  "git log",
  "git status",
  "git diff",
];

export interface ToolRegistry {
  register(name: string, tool: Tool): void;
  get(name: string): Tool | undefined;
  list(): string[];
  entries(): [string, Tool][];
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();

  return {
    register(name: string, tool: Tool) {
      tools.set(name, tool);
      return;
    },
    get(name: string): Tool | undefined {
      return tools.get(name);
    },
    list(): string[] {
      return [...tools.keys()];
    },
    entries(): [string, Tool][] {
      return [...tools.entries()];
    },
  };
}

export function registerBuiltins(
  registry: ToolRegistry,
  sandbox: Sandbox,
  skills: Skill[],
) {
  registry.register("read", createReadTool(sandbox));
  registry.register("grep", createGrepTool(sandbox));

  const interactiveBash = createBashTool(
    sandbox,
    createApproval({ mode: "interactive" }),
  );
  const backgroundBash = createBashTool(
    sandbox,
    createApproval({ mode: "background" }),
  );
  const delegatedBash = createBashTool(
    sandbox,
    createApproval({ mode: "delegated", trust: SAFE_PREFIXES }),
  );
  registry.register("bash", backgroundBash);

  registry.register(
    "task",
    createTaskTool(sandbox, {
      read: registry.get("read")!,
      grep: registry.get("grep")!,
    }),
  );
  registry.register("askUser", createAskUserTool());
  registry.register("todo", createTodoTool());
  registry.register("loadSkill", createLoadSkillTool(skills));
}

interface WrapHooks {
  beforeExecute?: (input: any) => any | Promise<any>;
  afterExecute?: (result: any) => any | Promise<any>;
}

export function wrapTool(base: Tool, hooks: WrapHooks): Tool {
  return tool({
    description: base.description,
    inputSchema: base.inputSchema,
    execute: async (input) => {
      const transformed = hooks.beforeExecute
        ? await hooks.beforeExecute(input)
        : input;
      const result = await base.execute(transformed);
      return hooks.afterExecute ? await hooks.afterExecute(result) : result;
    },
  });
}
