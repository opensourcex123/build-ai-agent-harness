import { ToolLoopAgent, stepCountIs, pruneMessages, tool } from "ai";
import "dotenv/config";
import { deepseek } from "@ai-sdk/deepseek";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { buildSystemPrompt } from "./system";
import { createLocalSandbox } from "./sandbox-local";
import { SandboxLifecycle } from "./sandbox";
import { createJustBashSandbox } from "./sandbox-just-bash";
import { addCacheControl } from "./cache";
import { discoverGates } from "./verification";
import { parseArgs } from "node:util";
import { discoverSkills } from "./skill";
import { createRegistry, registerBuiltins, wrapTool } from "./registry";
import { z } from "zod";

type ApprovalConfig =
  | { mode: "interactive" }
  | { mode: "background" }
  | { mode: "delegated"; trust: string[] };

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

  const skillDirs = [
    join(workingDir, "skills"),
    join(process.env.HOME ?? "", ".harness", "skills"),
  ];
  const skills = discoverSkills(skillDirs);
  const registry = createRegistry();
  registerBuiltins(registry, sandbox, skills);

  registry.register(
    "now",
    tool({
      description: "Return the current timestamp",
      inputSchema: z.object({}),
      execute: async () => new Date().toISOString(),
    }),
  );

  const baseBash = registry.get("bash")!;
  registry.register(
    "bash",
    wrapTool(baseBash, {
      beforeExecute: (input) => {
        if (input.command.startsWith("bun test")) {
          return { ...input, command: input.command + " --reporter=spec" };
        }
        return input;
      },
    }),
  );

  const verifyCommands = await discoverGates(sandbox);
  const instructions = buildSystemPrompt({
    workingDirectory: workingDir,
    sandboxType: "local",
    toolNames: registry.list(),
    projectContext,
    verifyCommands,
  });

  const agent = new ToolLoopAgent({
    model: deepseek(values.model!),
    instructions,
    tools: Object.fromEntries(registry.entries()),
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
