import { createConnection } from "node:net";
import type { BridgeRequest, BridgeResponse, ReadyResponse } from "./protocol.js";

export interface ClientResult {
  ready: ReadyResponse;
  response: BridgeResponse;
}

export async function sendBridgeRequest(
  socketPath: string,
  request: BridgeRequest,
  timeoutMs = 3_000,
): Promise<ClientResult> {
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  const lines: BridgeResponse[] = [];
  let buffer = "";

  return await new Promise<ClientResult>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the local bridge.")), timeoutMs);
    const finish = (error?: Error, result?: ClientResult): void => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const rawLines = buffer.split("\n");
      buffer = rawLines.pop() ?? "";
      for (const rawLine of rawLines) {
        if (!rawLine.trim()) continue;
        let message: BridgeResponse;
        try {
          message = JSON.parse(rawLine) as BridgeResponse;
        } catch {
          finish(new Error("Bridge returned invalid JSON."));
          return;
        }
        lines.push(message);
        const ready = lines.find((item): item is ReadyResponse => item.type === "ready");
        if (message.type === "ready") {
          socket.write(`${JSON.stringify(request)}\n`);
          continue;
        }
        if (ready && (message.type === "ack" || message.type === "error" || message.type === "snapshot")) {
          finish(undefined, { ready, response: message });
          return;
        }
      }
    });
  });
}
