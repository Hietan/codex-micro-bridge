import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export function chatGptLaunchArguments(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("A valid explicit CDP port is required to launch ChatGPT.");
  }
  return [
    "-gj",
    "-a",
    "ChatGPT",
    "--args",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ];
}

export async function launchChatGptWithCdp(port: number): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Automatic ChatGPT launch is currently available only on macOS.");
  await execFile("/usr/bin/open", chatGptLaunchArguments(port));
}
