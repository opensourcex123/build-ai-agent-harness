import { ToolLoopAgent, stepCountIs, tool } from "ai";
import "dotenv/config";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { buildSystemPrompt } from "./system";
import { createBashTool, createReadTool } from "./tools";

interface BashOperations {
  exec(command: string): Promise<{ stdout: string; exitCode: number }>;
}

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

  const localOps: BashOperations = {
    exec: async (command) => {
      try {
        const stdout = execSync(command, {
          workingDir,
          encoding: "utf-8",
          timeout: 30_000,
        });
        return { stdout, exitCode: 0 };
      } catch (e: any) {
        return {
          stdout: e.stdout || e.stderr || e.message || "",
          exitCode: e.status ?? 1,
        };
      }
    },
  };

  const read = createReadTool();
  const grep = tool({
    description: `Search file contents using regex. Returns matching lines with file paths.
 
WHEN TO USE: finding patterns across multiple files, locating function definitions,
  searching for imports, finding TODOs or error messages.
 
WHEN NOT TO USE: reading a known file (use read instead).
  Running commands (use bash instead).
 
DO NOT USE FOR: reading files (use read), listing directories (use bash),
  modifying files (use edit).
 
USAGE: pattern is a regex string. glob filters by file extension.
  Results are capped at 50 matches.
 
EXAMPLES:
  - Find all TODO comments: pattern "TODO" glob "*.ts"
  - Find function definitions: pattern "function \\\\w+" glob "*.ts"
  - Find imports of a package: pattern "from 'express'" glob "*.ts"`,
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      path: z
        .string()
        .optional()
        .describe("Directory to search (default: working dir)"),
      glob: z.string().optional().describe("File glob filter, e.g. '*.ts'"),
    }),
    execute: async ({ pattern, path: searchPath, glob: globFilter }) => {
      const dir = resolve(workingDir, searchPath || ".");
      const escapedPattern = pattern.replace(/'/g, `'\\''`);
      const escapedGlob = (globFilter || "*").replace(/'/g, `'\\''`);
      const cmd = `grep -rn --exclude-dir=node_modules --exclude-dir=.git --include='${escapedGlob}' -E '${escapedPattern}' '${dir}' 2>/dev/null`;

      try {
        const stdout = execSync(cmd, { encoding: "utf-8", timeout: 10_000 });
        const lines = stdout.trim().split("\\n").filter(Boolean);

        const MAX_MATCHES = 50;
        const truncated = lines.length > MAX_MATCHES;
        const result = truncated ? lines.slice(0, MAX_MATCHES) : lines;

        return truncated
          ? result.join("\\n") +
              `\\n... (${lines.length} total, showing first ${MAX_MATCHES})`
          : result.join("\\n") || "No matches found.";
      } catch (error: any) {
        const stdout = String(error?.stdout || "").trim();
        if (stdout) {
          const lines = stdout.split("\\n").filter(Boolean);
          const MAX_MATCHES = 50;
          const truncated = lines.length > MAX_MATCHES;
          const result = truncated ? lines.slice(0, MAX_MATCHES) : lines;
          return truncated
            ? result.join("\\n") +
                `\\n... (${lines.length} total, showing first ${MAX_MATCHES})`
            : result.join("\\n");
        }
        return "No matches found.";
      }
    },
  });
  const interactiveBash = createBashTool(
    localOps,
    createApproval({ mode: "interactive" }),
  );
  const backgroundBash = createBashTool(
    localOps,
    createApproval({ mode: "background" }),
  );
  const delegatedBash = createBashTool(
    localOps,
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
