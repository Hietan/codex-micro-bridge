import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DebugTarget {
  id?: string;
  title?: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface PortDiscoveryOptions {
  explicitPort?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  processList?: string;
}

export function selectCodexMainTarget(targets: DebugTarget[]): DebugTarget | undefined {
  const candidates = targets.filter(
    (target) => target.type === "page" && Boolean(target.webSocketDebuggerUrl) && target.url.startsWith("app://"),
  );
  const isIndexDocument = (target: DebugTarget): boolean => {
    try {
      return new URL(target.url).pathname === "/index.html";
    } catch {
      return false;
    }
  };
  const isAuxiliary = (target: DebugTarget): boolean => /avatar-overlay|composition-surface/i.test(target.url);

  return (
    candidates.find((target) => isIndexDocument(target) && !new URL(target.url).search) ??
    candidates.find(isIndexDocument) ??
    candidates.find((target) => !isAuxiliary(target) && !target.url.includes("initialRoute=")) ??
    candidates.find((target) => !isAuxiliary(target))
  );
}

export function parseDebugPortFromProcessList(processList: string): number | null {
  for (const line of processList.split("\n")) {
    if (!/ChatGPT\.app\/Contents\/MacOS\/ChatGPT|\.app\/Contents\/MacOS\/ChatGPT/.test(line)) continue;
    if (!line.includes("--remote-debugging-address=127.0.0.1")) continue;
    const match = /--remote-debugging-port(?:=|\s+)(\d+)/.exec(line);
    const port = match ? Number(match[1]) : Number.NaN;
    if (isValidPort(port)) return port;
  }
  return null;
}

export async function discoverDebugPort(options: PortDiscoveryOptions = {}): Promise<number> {
  if (options.explicitPort !== undefined) return requireValidPort(options.explicitPort, "--port");

  const envValue = (options.env ?? process.env).CODEX_MICRO_CDP_PORT;
  if (envValue !== undefined) return requireValidPort(Number(envValue), "CODEX_MICRO_CDP_PORT");

  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const processList =
      options.processList ?? (await execFileAsync("/bin/ps", ["-axo", "command="], { timeout: 4_000 })).stdout;
    const port = parseDebugPortFromProcessList(processList);
    if (port !== null) return port;
  }

  throw new Error(
    "Could not discover a loopback Codex CDP port. Pass --port or set CODEX_MICRO_CDP_PORT after launching ChatGPT with remote debugging enabled.",
  );
}

export async function fetchDebugTargets(port: number, timeoutMs = 1_500): Promise<DebugTarget[]> {
  const response = await fetch(`http://127.0.0.1:${requireValidPort(port, "CDP port")}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Codex CDP target list returned HTTP ${response.status}.`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) throw new Error("Codex CDP target list was not an array.");
  return value as DebugTarget[];
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65_535;
}

function requireValidPort(value: number, source: string): number {
  if (!isValidPort(value)) throw new Error(`${source} must be an integer between 1 and 65535.`);
  return value;
}
