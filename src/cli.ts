#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CodexMicroBridge, MockBridge } from "./bridge.js";
import { sendBridgeRequest } from "./client.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  isMicroKeyId,
  parseBridgeRequest,
  type BridgeRequest,
  type JoystickRequest,
  type KeyRequest,
  type MicroKeyId,
} from "./protocol.js";
import { BridgeServer, defaultSocketPath } from "./server.js";
import { QmkRawHidAdapter } from "./hifumi-hid.js";
import {
  installLaunchAgent,
  launchAgentStatus,
  servicePaths,
  uninstallLaunchAgent,
} from "./service.js";
import { launchChatGptWithCdp } from "./chatgpt-launcher.js";

const VERSION = "0.1.0";
const JOYSTICK_ANGLES = { up: 0.75, right: 0, down: 0.25, left: 0.5 } as const;

interface Options {
  port?: number;
  socketPath: string;
  mock: boolean;
  json: boolean;
  threadKey?: string;
  hid: boolean;
  hidVendorId?: number;
  hidProductId?: number;
  wait: boolean;
  launchChatGpt: boolean;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  const { positional, options } = parseOptions(args);
  if (command === "start") {
    await startServer(options);
    return;
  }
  if (command === "service") {
    await manageService(positional[0], options);
    return;
  }
  if (command === "probe") {
    await probeCodex(options);
    return;
  }
  if (command === "snapshot") {
    await snapshotCodex(options);
    return;
  }
  if (command === "status") {
    await sendAndPrint(options, { v: 1, id: randomUUID(), type: "ping" });
    return;
  }
  if (command === "tap" || command === "press" || command === "release") {
    const key = requireKey(positional[0]);
    const act = command === "release" ? 0 : 1;
    const request = keyRequest(key, act, options.threadKey);
    await sendAndPrint(options, request);
    if (command === "tap") {
      await delay(35);
      await sendAndPrint(options, keyRequest(key, 0, options.threadKey));
    }
    return;
  }
  if (command === "encoder") {
    const direction = positional[0];
    if (direction !== "cw" && direction !== "ccw") throw new Error("encoder direction must be cw or ccw.");
    const key: MicroKeyId = direction === "cw" ? "ENC_CW" : "ENC_CC";
    await sendAndPrint(options, { v: 1, id: randomUUID(), type: "key", key, act: 2 });
    return;
  }
  if (command === "joystick") {
    const direction = positional[0] as keyof typeof JOYSTICK_ANGLES | undefined;
    const state = positional[1] ?? "press";
    if (!direction || !(direction in JOYSTICK_ANGLES)) throw new Error("joystick direction must be up, right, down, or left.");
    if (state !== "press" && state !== "release") throw new Error("joystick state must be press or release.");
    const request: JoystickRequest = {
      v: 1,
      id: randomUUID(),
      type: "joystick",
      angle: JOYSTICK_ANGLES[direction],
      distance: state === "press" ? 1 : 0,
    };
    await sendAndPrint(options, request);
    return;
  }
  if (command === "send-json") {
    const input = positional.join(" ");
    if (!input) throw new Error("send-json requires one JSON request argument.");
    const request = parseBridgeRequest(JSON.parse(input));
    await sendAndPrint(options, request);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function startServer(options: Options): Promise<void> {
  const log = (message: string): void => {
    if (!options.json) console.error(message);
  };
  const bridge = options.mock
    ? new MockBridge(log)
    : new CodexMicroBridge({ ...(options.port === undefined ? {} : { port: options.port }), logger: log });
  const server = new BridgeServer(bridge, { socketPath: options.socketPath, logger: log });
  const probe = await startWithRetry(server, options, log);
  const hidAdapter = options.hid
    ? new QmkRawHidAdapter(bridge, {
        logger: log,
        stateProvider: bridge,
        ...(options.hidVendorId === undefined ? {} : { vendorId: options.hidVendorId }),
        ...(options.hidProductId === undefined ? {} : { productId: options.hidProductId }),
      })
    : undefined;
  const hidConnected = hidAdapter ? await hidAdapter.start() : false;
  print(options, {
    status: "ready",
    socketPath: options.socketPath,
    hid: options.hid ? (hidConnected ? "connected" : "waiting") : "disabled",
    ...probe,
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await hidAdapter?.close();
    await server.close();
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  await new Promise<void>(() => undefined);
}

async function startWithRetry(server: BridgeServer, options: Options, log: (message: string) => void) {
  let launchAttempted = false;
  for (;;) {
    try {
      return await server.start();
    } catch (error) {
      let launchedNow = false;
      if (options.launchChatGpt && !launchAttempted) {
        if (options.port === undefined) throw new Error("--launch-chatgpt requires --port.");
        launchAttempted = true;
        launchedNow = true;
        log("ChatGPT is not ready; launching it in the background with loopback CDP.");
        await launchChatGptWithCdp(options.port);
      }
      if (!options.wait && !launchedNow) throw error;
      log(`Codex is not ready: ${errorMessage(error)}; retrying in 2 seconds.`);
      await delay(2_000);
    }
  }
}

async function manageService(action: string | undefined, options: Options): Promise<void> {
  if (action === "install") {
    const paths = await installLaunchAgent({
      nodePath: process.execPath,
      cliPath: fileURLToPath(import.meta.url),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.hidVendorId === undefined ? {} : { vendorId: options.hidVendorId }),
      ...(options.hidProductId === undefined ? {} : { productId: options.hidProductId }),
      launchChatGpt: options.launchChatGpt,
    });
    print(options, { status: "installed", ...paths });
    return;
  }
  if (action === "uninstall") {
    print(options, { status: "uninstalled", ...(await uninstallLaunchAgent()) });
    return;
  }
  if (action === "status") {
    print(options, { status: await launchAgentStatus(), ...servicePaths() });
    return;
  }
  throw new Error("service requires install, uninstall, or status.");
}

async function probeCodex(options: Options): Promise<void> {
  const bridge = new CodexMicroBridge({
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.json ? {} : { logger: (message: string) => console.error(message) }),
  });
  try {
    print(options, await bridge.probe());
  } finally {
    bridge.close();
  }
}

async function snapshotCodex(options: Options): Promise<void> {
  const bridge = new CodexMicroBridge({
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.json ? {} : { logger: (message: string) => console.error(message) }),
  });
  try {
    print(options, await bridge.snapshot());
  } finally {
    bridge.close();
  }
}

async function sendAndPrint(options: Options, request: BridgeRequest): Promise<void> {
  const result = await sendBridgeRequest(options.socketPath, request);
  if (result.response.type === "error") {
    throw new Error(`${result.response.error.code}: ${result.response.error.message}`);
  }
  print(options, result.response);
}

function keyRequest(key: MicroKeyId, act: 0 | 1, threadKey: string | undefined): KeyRequest {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    id: randomUUID(),
    type: "key",
    key,
    act,
    ...(threadKey === undefined ? {} : { threadKey }),
  };
}

function requireKey(value: string | undefined): MicroKeyId {
  if (!isMicroKeyId(value)) throw new Error(`Unknown or missing Codex Micro key: ${String(value)}`);
  if (value === "ENC_CW" || value === "ENC_CC") throw new Error("Use the encoder command for ENC_CW and ENC_CC.");
  return value;
}

function parseOptions(args: string[]): { positional: string[]; options: Options } {
  const positional: string[] = [];
  const options: Options = {
    socketPath: defaultSocketPath(), mock: false, json: false, hid: true,
    wait: false, launchChatGpt: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mock") {
      options.mock = true;
    } else if (arg === "--no-hid") {
      options.hid = false;
    } else if (arg === "--wait") {
      options.wait = true;
    } else if (arg === "--launch-chatgpt") {
      options.launchChatGpt = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--port") {
      const value = args[++index];
      if (!value) throw new Error("--port requires a value.");
      options.port = Number(value);
    } else if (arg === "--socket") {
      const value = args[++index];
      if (!value) throw new Error("--socket requires a path.");
      options.socketPath = value;
    } else if (arg === "--thread-key") {
      const value = args[++index];
      if (!value) throw new Error("--thread-key requires a value.");
      options.threadKey = value;
    } else if (arg === "--hid-vid") {
      options.hidVendorId = parseUsbId(args[++index], "--hid-vid");
    } else if (arg === "--hid-pid") {
      options.hidProductId = parseUsbId(args[++index], "--hid-pid");
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function parseUsbId(value: string | undefined, option: string): number {
  if (!value) throw new Error(`${option} requires a hexadecimal USB ID.`);
  const normalized = value.toLowerCase().startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-f]{1,4}$/i.test(normalized)) throw new Error(`${option} must be a 1-4 digit hexadecimal USB ID.`);
  return Number.parseInt(normalized, 16);
}

function print(options: Options, value: unknown): void {
  if (options.json) {
    console.log(JSON.stringify(value));
  } else if (typeof value === "object" && value !== null) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(String(value));
  }
}

function printUsage(): void {
  console.log(`codex-micro-bridge ${VERSION}

Usage:
  codex-micro-bridge start [--port PORT] [--wait] [--launch-chatgpt] [--socket PATH] [--mock] [--no-hid] [--hid-vid HEX] [--hid-pid HEX] [--json]
  codex-micro-bridge service <install|uninstall|status> [--port PORT] [--launch-chatgpt] [--hid-vid HEX] [--hid-pid HEX]
  codex-micro-bridge probe [--port PORT] [--json]
  codex-micro-bridge snapshot [--port PORT] [--json]
  codex-micro-bridge status [--socket PATH] [--json]
  codex-micro-bridge tap KEY [--thread-key TASK_ID] [--socket PATH]
  codex-micro-bridge press KEY [--thread-key TASK_ID] [--socket PATH]
  codex-micro-bridge release KEY [--thread-key TASK_ID] [--socket PATH]
  codex-micro-bridge encoder <cw|ccw> [--socket PATH]
  codex-micro-bridge joystick <up|right|down|left> [press|release] [--socket PATH]
  codex-micro-bridge send-json '<JSON>' [--socket PATH]

Examples:
  codex-micro-bridge start --port 9222
  codex-micro-bridge snapshot --port 9222
  codex-micro-bridge tap ACT06
  codex-micro-bridge press ACT10
  codex-micro-bridge release ACT10
  codex-micro-bridge encoder cw
  codex-micro-bridge start --mock
`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
