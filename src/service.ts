import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const LAUNCH_AGENT_LABEL = "dev.codex-control.bridge";

export interface ServiceInstallOptions {
  nodePath: string;
  cliPath: string;
  port?: number;
  vendorId?: number;
  productId?: number;
  launchChatGpt?: boolean;
  home?: string;
}

export interface ServicePaths {
  plist: string;
  stdout: string;
  stderr: string;
}

export function servicePaths(home = homedir()): ServicePaths {
  return {
    plist: join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
    stdout: join(home, "Library", "Logs", "CodexControlBridge.log"),
    stderr: join(home, "Library", "Logs", "CodexControlBridge.error.log"),
  };
}

export function buildLaunchAgentPlist(options: ServiceInstallOptions): string {
  if (options.launchChatGpt && options.port === undefined) {
    throw new Error("launchChatGpt requires an explicit CDP port.");
  }
  const paths = servicePaths(options.home);
  const args = [options.nodePath, options.cliPath, "start", "--wait", "--json"];
  if (options.port !== undefined) args.push("--port", String(options.port));
  if (options.vendorId !== undefined) args.push("--hid-vid", usbId(options.vendorId));
  if (options.productId !== undefined) args.push("--hid-pid", usbId(options.productId));
  if (options.launchChatGpt) args.push("--launch-chatgpt");
  const argumentsXml = args.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(paths.stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(paths.stderr)}</string>
  </dict>
</plist>
`;
}

export async function installLaunchAgent(options: ServiceInstallOptions): Promise<ServicePaths> {
  requireMacOs();
  const paths = servicePaths(options.home);
  await fs.mkdir(dirname(paths.plist), { recursive: true });
  await fs.mkdir(dirname(paths.stdout), { recursive: true });
  await fs.writeFile(paths.plist, buildLaunchAgentPlist(options), { encoding: "utf8", mode: 0o644 });
  await bootoutLaunchAgent(false);
  await execFile("/bin/launchctl", ["bootstrap", launchDomain(), paths.plist]);
  return paths;
}

export async function uninstallLaunchAgent(home = homedir()): Promise<ServicePaths> {
  requireMacOs();
  const paths = servicePaths(home);
  await bootoutLaunchAgent(false);
  try {
    await fs.unlink(paths.plist);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return paths;
}

export async function launchAgentStatus(): Promise<"running" | "not-loaded"> {
  requireMacOs();
  try {
    await execFile("/bin/launchctl", ["print", `${launchDomain()}/${LAUNCH_AGENT_LABEL}`]);
    return "running";
  } catch {
    return "not-loaded";
  }
}

async function bootoutLaunchAgent(required: boolean): Promise<void> {
  try {
    await execFile("/bin/launchctl", ["bootout", `${launchDomain()}/${LAUNCH_AGENT_LABEL}`]);
  } catch (error) {
    if (required) throw error;
  }
}

function launchDomain(): string {
  if (typeof process.getuid !== "function") throw new Error("A numeric user ID is required for launchd.");
  return `gui/${process.getuid()}`;
}

function requireMacOs(): void {
  if (process.platform !== "darwin") throw new Error("LaunchAgent service management is available only on macOS.");
}

function usbId(value: number): string {
  return value.toString(16).padStart(4, "0");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
