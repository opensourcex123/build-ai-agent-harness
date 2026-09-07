import { Sandbox } from "./sandbox";
import { tool } from "ai";
import { z } from "zod";
import { resolve } from "node:path";

export function createReadTool(sandbox: Sandbox) {
  return tool({
    description: `Read a file from the project. Returns numbered lines.
 
WHEN TO USE: viewing file contents, checking configurations, reading source code,
  examining specific lines with offset/limit.
 
WHEN NOT TO USE: searching for patterns across files (use grep instead).
  Running commands (use bash instead).
 
DO NOT USE FOR: searching code (use grep), executing commands (use bash),
  modifying files (use edit or write).
 
USAGE: path is relative to working directory. offset and limit are optional.
  Output is capped at 500 lines.`,
    inputSchema: z.object({
      path: z.string().describe("File path relative to working directory"),
      offset: z.number().optional().describe("Start line (1-indexed)"),
      limit: z.number().optional().describe("Max lines to return"),
    }),
    execute: async ({ path: filePath, offset, limit }) => {
      const abs = resolve(workingDir, filePath);
      const content = await sandbox.readFile(abs);
      let lines = content.split("\n");

      if (offset) lines = lines.slice(offset - 1);
      if (limit) lines = lines.slice(0, limit);

      const MAX_LINES = 500;
      const truncated = lines.length > MAX_LINES;
      if (truncated) lines = lines.slice(0, MAX_LINES);

      const numbered = lines.map((l, i) => `${(offset || 1) + i}: ${l}`);
      return truncated
        ? numbered.join("\n") + `\n... (truncated at ${MAX_LINES} lines)`
        : numbered.join("\n");
    },
  });
}

export function createBashTool(
  sandbox: Sandbox,
  needApproval: (input: { command: string }) => boolean,
) {
  return tool({
    description: `Execute a shell command in the working directory.
 
WHEN TO USE: running build commands, installing packages, running tests,
  git operations, directory listings.
 
WHEN NOT TO USE: reading file contents (use read instead).
  Searching for patterns (use grep instead).
 
DO NOT USE FOR: reading files (use read), searching code (use grep).
 
USAGE: command is a single shell string. Commands not in the safe-prefix
  allowlist are blocked and return a clear error message.`,
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
    }),
    execute: async ({ command }) => {
      if (needApproval({ command })) {
        return `Blocked: "${command}" requires approval.`;
      }
      const { stdout } = await sandbox.exec(command);
      return stdout || "(no output)";
    },
  });
}
