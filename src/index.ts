import { ToolLoopAgent, stepCountIs, pruneMessages } from "ai";
import "dotenv/config";
import { deepseek } from "@ai-sdk/deepseek";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { buildSystemPrompt } from "./system";
import {
  createAskUserTool,
  createBashTool,
  createGrepTool,
  createLoadSkillTool,
  createReadTool,
  createTaskTool,
  createTodoTool,
} from "./tools";
import { createLocalSandbox } from "./sandbox-local";
import { SandboxLifecycle } from "./sandbox";
import { createJustBashSandbox } from "./sandbox-just-bash";
import { addCacheControl } from "./cache";
import { discoverGates } from "./verification";
import { parseArgs } from "node:util";
import { discoverSkills } from "./skill";

type ApprovalConfig =
  | { mode: "interactive" }
  | { mode: "background" }
  | { mode: "delegated"; trust: string[] };

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

export function createApproval(config: ApprovalConfig) {
  return ({ command }: { command: string }) => {
    if (config.mode === "background") return false;

    if (config.mode === "delegated") {
      return !config.trust.some((p) => command.trim().startsWith(p));
    }

    return !SAFE_PREFIXES.some((p) => command.trim().startsWith(p));
  };
}

const run = async () => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      sandbox: { type: "string", default: "local" },
      model: { type: "string", default: "deepseek-v4-pro" },
    },
    allowPositionals: true,
  });

  const workingDir = resolve(positionals[0] || process.cwd());
  console.log(workingDir);

  const agentsPath = join(workingDir, "AGENTS.md");
  const projectContext = existsSync(agentsPath)
    ? readFileSync(agentsPath, "utf-8")
    : undefined;

  async function sandboxFromFlag(name: string, dir: string): Promise<Sandbox> {
    if (name === "just-bash") return createJustBashSandbox(dir);
    return createLocalSandbox(dir);
  }

  const sandbox = await sandboxFromFlag(values.sandbox!, workingDir);
  console.error(`Sandbox: ${sandbox.type}`);

  const lifecycle: SandboxLifecycle = {
    afterStart: async (sb) =>
      console.error(`[lifecycle] after start: ${sb.type}`),
    beforeStop: async (sb) =>
      console.error(`[lifecycle] before stop: ${sb.type}`),
  };

  await lifecycle.afterStart?.(sandbox);

  const read = createReadTool(sandbox);
  const grep = createGrepTool(sandbox);
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
  const task = createTaskTool(sandbox, { read: read, grep: grep });
  const askUser = createAskUserTool(sandbox);
  const todo = createTodoTool();

  const skillDirs = [
    join(workingDir, "skills"),
    join(process.env.HOME ?? "", ".harness", "skills"),
  ];
  const skills = discoverSkills(skillDirs);
  const loadSkillTool = createLoadSkillTool(skills);

  const verifyCommands = await discoverGates(sandbox);
  const instructions = buildSystemPrompt({
    workingDirectory: workingDir,
    sandboxType: "local",
    toolNames: Object.keys({ read, grep, backgroundBash }),
    projectContext,
    verifyCommands,
  });

  const agent = new ToolLoopAgent({
    model: deepseek(values.model!),
    instructions,
    tools: { read, grep, backgroundBash, task, askUser, todo, loadSkillTool },
    stopWhen: stepCountIs(15),
    prepareCall: async (options) => {
      const pruned = options.messages
        ? pruneMessages({
            messages: options.messages,
            toolCalls: "before-last-3-messages",
          })
        : undefined;

      return {
        ...options,
        messages: pruned ? addCacheControl(pruned) : undefined,
      };
    },
    onStepEnd: ({ usage, stepNumber }) => {
      console.error(
        `Step ${stepNumber}: ${usage.inputTokens} input, ${usage.outputTokens} output`,
      );
    },
  });

  const prompt = positionals.slice(1).join(" ") || "Hello!";

  process.on("SIGINT", async () => {
    console.error("\nShutting down...");
    await sandbox.stop();
    process.exit(0);
  });

  try {
    const result = await agent.stream({ prompt });

    for await (const chunk of result.stream) {
      switch (chunk.type) {
        case "text-delta":
          process.stdout.write(chunk.text);
          break;
        case "tool-call":
          console.error(
            `\n[tool] ${chunk.toolName}(${JSON.stringify(chunk.input)})`,
          );
          break;
        case "tool-result": {
          const preview = (
            typeof chunk.output === "string"
              ? chunk.output
              : (JSON.stringify(chunk.output) ?? "(no output)")
          ).slice(0, 100);
          console.error(`  -> ${preview}`);
          break;
        }
      }
    }
  } finally {
    await lifecycle.beforeStop?.(sandbox);
    await sandbox.stop();
  }
};

run();
