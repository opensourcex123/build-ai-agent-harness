import type { Sandbox } from "./sandbox";
import { Sandbox as JustBashSandbox } from "just-bash";

const MOUNT = "/home/user/project";

export async function createJustBashSandbox(dir: string): Promise<Sandbox> {
  const jb = await JustBashSandbox.create({
    overlayRoot: dir,
  });

  async function readFile(path: string) {
    const virtualPath = `${MOUNT}/${path}`;
    return jb.readFile(virtualPath);
  }

  async function exec(command: string) {
    const cmd = await jb.runCommand(command, {
      cwd: MOUNT,
    });
    const finished = await cmd.wait();
    return { stdout: await cmd.output(), exitCode: finished.exitCode };
  }

  async function stop() {}

  return {
    type: "just-bash",
    workingDirectory: dir,
    readFile,
    exec,
    stop,
  };
}
