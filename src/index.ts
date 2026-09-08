import { ToolLoopAgent, stepCountIs } from "ai";
import "dotenv/config";
import { deepseek } from "@ai-sdk/deepseek";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { buildSystemPrompt } from "./system";
import { createBashTool, createGrepTool, createReadTool } from "./tools";
import { createLocalSandbox } from "./sandbox-local";
import { Sandbox } from "./sandbox";
import { createJustBashSandbox } from "./sandbox-just-bash";

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

function createApproval(config: ApprovalConfig) {
  return ({ command }: { command: string }) => {
    if (config.mode === "background") return false;

    if (config.mode === "delegated") {
      return !config.trust.some((p) => command.trim().startsWith(p));
    }

    return !SAFE_PREFIXES.some((p) => command.trim().startsWith(p));
  };
}

const run = async () => {
  const workingDir = process.argv[2] || process.cwd();
  console.log(workingDir);

  const agentsPath = join(workingDir, "AGENTS.md");
  const projectContext = existsSync(agentsPath)
    ? readFileSync(agentsPath, "utf-8")
    : undefined;

  const sandboxType = process.env.SANDBOX || "local";
  const sandbox =
    sandboxType === "just-bash"
      ? await createJustBashSandbox(workingDir)
      : createLocalSandbox(workingDir);
  console.error(`Sandbox: ${sandbox.type}`);

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

  const instructions = buildSystemPrompt({
    workingDirectory: workingDir,
    sandboxType: "local",
    toolNames: Object.keys({ read, grep, interactiveBash }),
    projectContext,
  });

  const agent = new ToolLoopAgent({
    model: deepseek("deepseek-v4-flash"),
    instructions,
    tools: { read, grep, interactiveBash },
    stopWhen: stepCountIs(20),
  });

  const prompt = process.argv.slice(3).join(" ") || "Hello!";
  const { text, steps } = await agent.generate({ prompt });
  console.log(text);
  console.log(`\n(${steps.length} steps)`);
};

run();
