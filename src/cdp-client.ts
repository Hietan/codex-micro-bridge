import { randomUUID } from "node:crypto";

interface CdpResponse {
  id?: number;
  result?: {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RuntimeEvaluator {
  evaluate<T = unknown>(expression: string): Promise<T>;
  close(): void;
}

export class CdpClient implements RuntimeEvaluator {
  private socket: WebSocket | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly namespace = randomUUID();

  constructor(
    private readonly websocketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
    private readonly timeoutMs = 6_000,
  ) {}

  async connect(url: string): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socket = this.websocketFactory(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out while connecting to the Codex renderer.")), 3_000);
      const onOpen = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("error", onError);
        resolve();
      };
      const onError = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        reject(new Error("Failed to connect to the Codex renderer WebSocket."));
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => this.disconnect(socket, new Error("Codex renderer disconnected.")));
    socket.addEventListener("error", () => this.disconnect(socket, new Error("Codex renderer WebSocket failed.")));
    this.socket = socket;
  }

  evaluate<T = unknown>(expression: string): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex renderer is not connected."));
    }
    const id = ++this.nextId;
    const retained = retainEvaluationPromise(expression, `${this.namespace}-${id}`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex Runtime.evaluate timed out."));
      }, this.timeoutMs);
      this.pending.set(id, { timer, resolve: (value) => resolve(value as T), reject });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression: retained, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  }

  close(): void {
    this.disconnect(this.socket, new Error("Codex CDP client was closed."));
  }

  private handleMessage(data: unknown): void {
    const raw = toText(data);
    if (raw === null) return;
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? "Unknown CDP error."));
      return;
    }
    const result = message.result;
    if (result?.exceptionDetails) {
      pending.reject(
        new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            "Codex renderer evaluation failed.",
        ),
      );
      return;
    }
    pending.resolve(result?.result?.value);
  }

  private disconnect(expected: WebSocket | undefined, reason: Error): void {
    if (expected && this.socket && this.socket !== expected) return;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

export function retainEvaluationPromise(expression: string, id: string | number): string {
  const key = `codex-micro-bridge-${id}`;
  return `(() => {
    const store = globalThis.__codexMicroBridgePendingEvaluations ??= new Map();
    const pending = Promise.resolve((${expression}));
    store.set(${JSON.stringify(key)}, pending);
    setTimeout(() => store.delete(${JSON.stringify(key)}), 10000);
    return pending;
  })()`;
}

function toText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}
