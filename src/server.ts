import { promises as fs } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeDispatcher, BridgeProbe } from "./bridge.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  ProtocolError,
  parseBridgeRequest,
  type BridgeRequest,
  type BridgeResponse,
  type ErrorResponse,
} from "./protocol.js";

const MAX_LINE_BYTES = 16 * 1024;

export interface BridgeServerOptions {
  socketPath?: string;
  logger?: (message: string) => void;
}

export class BridgeServer {
  private server: Server | undefined;
  private probe: BridgeProbe | undefined;
  private ownsSocket = false;
  readonly socketPath: string;
  private readonly logger: (message: string) => void;

  constructor(
    private readonly bridge: BridgeDispatcher,
    options: BridgeServerOptions = {},
  ) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.logger = options.logger ?? (() => undefined);
  }

  async start(): Promise<BridgeProbe> {
    if (this.server) throw new Error("Bridge server is already running.");
    this.probe = await this.bridge.probe();
    await prepareSocketPath(this.socketPath);
    const server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(this.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
    this.ownsSocket = true;
    try {
      await fs.chmod(this.socketPath, 0o600);
    } catch (error) {
      await this.close();
      throw error;
    }
    this.logger(`Bridge socket listening at ${this.socketPath}.`);
    return this.probe;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    this.bridge.close();
    if (this.ownsSocket) {
      this.ownsSocket = false;
      try {
        await fs.unlink(this.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private handleConnection(socket: Socket): void {
    const probe = this.probe;
    if (!probe) {
      socket.destroy(new Error("Bridge was not initialized."));
      return;
    }
    writeJson(socket, {
      v: BRIDGE_PROTOCOL_VERSION,
      type: "ready" as const,
      mode: probe.mode,
      ...(probe.target === undefined ? {} : { target: probe.target }),
      ...(probe.port === undefined ? {} : { port: probe.port }),
    });

    let buffer = "";
    let queue = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        writeJson(socket, errorResponse(undefined, "message_too_large", `Messages are limited to ${MAX_LINE_BYTES} bytes.`));
        socket.end();
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        queue = queue.then(() => this.processLine(socket, line));
      }
    });
    socket.on("error", (error) => this.logger(`Client socket error: ${error.message}`));
  }

  private async processLine(socket: Socket, line: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      writeJson(socket, errorResponse(undefined, "invalid_json", "Message is not valid JSON."));
      return;
    }

    let request: BridgeRequest;
    try {
      request = parseBridgeRequest(raw);
    } catch (error) {
      const id = typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string" ? raw.id : undefined;
      if (error instanceof ProtocolError) {
        writeJson(socket, errorResponse(id, error.code, error.message));
      } else {
        writeJson(socket, errorResponse(id, "invalid_request", errorMessage(error)));
      }
      return;
    }

    try {
      if (request.type === "hello" || request.type === "ping") {
        writeJson(socket, {
          v: 1,
          type: "ack",
          ...(request.id === undefined ? {} : { id: request.id }),
          status: "ready",
        });
        return;
      }
      if (request.type === "snapshot") {
        const snapshot = await this.bridge.snapshot();
        writeJson(socket, {
          v: 1,
          type: "snapshot",
          ...(request.id === undefined ? {} : { id: request.id }),
          slots: snapshot.slots.map((slot) => ({
            id: slot.id,
            assigned: slot.threadKey !== null,
            status: slot.status,
            selected: slot.selected,
          })),
        });
        return;
      }
      await this.bridge.dispatch(request);
      writeJson(socket, {
        v: 1,
        type: "ack",
        ...(request.id === undefined ? {} : { id: request.id }),
        status: "dispatched",
      });
    } catch (error) {
      writeJson(socket, errorResponse(request.id, "dispatch_failed", errorMessage(error)));
    }
  }
}

export function defaultSocketPath(): string {
  const suffix = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `codex-micro-bridge-${suffix}.sock`);
}

async function prepareSocketPath(path: string): Promise<void> {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket path: ${path}`);
    if (await acceptsConnections(path)) throw new Error(`Another bridge is already listening at ${path}`);
    await fs.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acceptsConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function writeJson(socket: Socket, message: BridgeResponse): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id: string | undefined, code: string, message: string): ErrorResponse {
  return { v: 1, type: "error", ...(id === undefined ? {} : { id }), error: { code, message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
