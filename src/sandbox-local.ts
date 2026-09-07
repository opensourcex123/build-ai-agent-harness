import type { Sandbox } from "./sandbox";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

export function createLocalSandbox(dir: string): Sandbox {
  async function readFile(path: string) {
    return readFileSync(resolve(dir, path), "utf-8");
  }

  async function exec(command: string) {
    try {
      const stdout = execSync(command, {
        cwd: dir,
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
  }

  async function stop() {}

  return {
    type: "local",
    workingDirectory: dir,
    readFile,
    exec,
    stop,
  };
}
