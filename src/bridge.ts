import { CdpClient, type RuntimeEvaluator } from "./cdp-client.js";
import { buildDispatchExpression, buildProbeExpression, type ProbeValue } from "./expressions.js";
import {
  agentSlotForKey,
  type DispatchRequest,
  type JoystickRequest,
  type KeyRequest,
} from "./protocol.js";
import {
  discoverDebugPort,
  fetchDebugTargets,
  selectCodexMainTarget,
  type DebugTarget,
} from "./target.js";
import { buildAgentSnapshotExpression, validateAgentSnapshot, type AgentSnapshot } from "./snapshot.js";

export interface BridgeProbe {
  mode: "codex" | "mock";
  target?: string;
  port?: number;
  hidHandlers?: number;
  joystickHandlers?: number;
}

export interface BridgeDispatcher extends AgentStateProvider {
  probe(): Promise<BridgeProbe>;
  dispatch(request: DispatchRequest): Promise<void>;
  close(): void;
}

export interface AgentStateProvider {
  snapshot(): Promise<AgentSnapshot>;
}

export interface ConnectedSession {
  evaluator: RuntimeEvaluator;
  port: number;
  target: DebugTarget;
}

export type SessionConnector = (explicitPort?: number) => Promise<ConnectedSession>;

export interface CodexBridgeOptions {
  port?: number;
  logger?: (message: string) => void;
  connector?: SessionConnector;
}

export class CodexMicroBridge implements BridgeDispatcher {
  private session: ConnectedSession | undefined;
  private connecting: Promise<ConnectedSession> | undefined;
  private readonly logger: (message: string) => void;
  private readonly connector: SessionConnector;

  constructor(private readonly options: CodexBridgeOptions = {}) {
    this.logger = options.logger ?? (() => undefined);
    this.connector = options.connector ?? connectDefaultSession;
  }

  async probe(): Promise<BridgeProbe> {
    const session = await this.ensureSession();
    try {
      const result = await session.evaluator.evaluate<ProbeValue>(buildProbeExpression());
      if (result.hidHandlers === 0) {
        throw new Error("Codex Micro HID handler did not become active after the device-state event.");
      }
      return {
        mode: "codex",
        target: session.target.url,
        port: session.port,
        hidHandlers: result.hidHandlers,
        joystickHandlers: result.joystickHandlers,
      };
    } catch (error) {
      this.invalidateSession(session);
      throw error;
    }
  }

  async dispatch(request: DispatchRequest): Promise<void> {
    const session = await this.ensureSession();
    try {
      if (request.type === "key") {
        await this.dispatchKey(session.evaluator, request);
      } else {
        await this.dispatchJoystick(session.evaluator, request);
      }
    } catch (error) {
      this.invalidateSession(session);
      throw error;
    }
  }

  async snapshot(): Promise<AgentSnapshot> {
    const session = await this.ensureSession();
    try {
      const value = await session.evaluator.evaluate<unknown>(buildAgentSnapshotExpression());
      return validateAgentSnapshot(value);
    } catch (error) {
      this.invalidateSession(session);
      throw error;
    }
  }

  close(): void {
    this.session?.evaluator.close();
    this.session = undefined;
  }

  private async ensureSession(): Promise<ConnectedSession> {
    if (this.session) return this.session;
    if (this.connecting) return this.connecting;
    this.connecting = this.connector(this.options.port);
    try {
      const session = await this.connecting;
      this.session = session;
      this.logger(`Connected to Codex CDP on 127.0.0.1:${session.port} (${session.target.url}).`);
      return session;
    } finally {
      this.connecting = undefined;
    }
  }

  private async dispatchKey(evaluator: RuntimeEvaluator, request: KeyRequest): Promise<void> {
    const slot = agentSlotForKey(request.key);
    let threadKey = request.threadKey ?? null;
    if (slot !== null && threadKey === null) {
      const snapshot = validateAgentSnapshot(
        await evaluator.evaluate<unknown>(buildAgentSnapshotExpression()),
      );
      threadKey = snapshot.slots[slot]?.threadKey ?? null;
    }
    const event = {
      key: request.key,
      act: request.act,
      agent: null,
      slot,
      threadKey,
    };
    await evaluator.evaluate(
      buildDispatchExpression(
        { type: "codex-micro-hid-event", event },
        "codex-micro-hid-event",
      ),
    );
  }

  private async dispatchJoystick(evaluator: RuntimeEvaluator, request: JoystickRequest): Promise<void> {
    await evaluator.evaluate(
      buildDispatchExpression(
        {
          type: "codex-micro-joystick-event",
          event: { angle: request.angle, distance: request.distance },
        },
        "codex-micro-joystick-event",
      ),
    );
  }

  private invalidateSession(expected: ConnectedSession): void {
    if (this.session !== expected) return;
    expected.evaluator.close();
    this.session = undefined;
  }
}

export class MockBridge implements BridgeDispatcher {
  readonly events: DispatchRequest[] = [];

  constructor(private readonly logger: (message: string) => void = () => undefined) {}

  async probe(): Promise<BridgeProbe> {
    return { mode: "mock", target: "mock://codex/index.html" };
  }

  async dispatch(request: DispatchRequest): Promise<void> {
    this.events.push(request);
    this.logger(`[mock] ${JSON.stringify(request)}`);
  }

  async snapshot(): Promise<AgentSnapshot> {
    return {
      slots: Array.from({ length: 6 }, (_, id) => ({
        id,
        threadKey: id === 0 ? "mock-thread" : null,
        status: id === 0 ? "working" : "off",
        selected: id === 0,
      })),
    };
  }

  close(): void {}
}

async function connectDefaultSession(explicitPort?: number): Promise<ConnectedSession> {
  const port = await discoverDebugPort(explicitPort === undefined ? {} : { explicitPort });
  const targets = await fetchDebugTargets(port);
  const target = selectCodexMainTarget(targets);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No primary Codex app:// renderer with a CDP WebSocket was found.");
  }
  const evaluator = new CdpClient();
  await evaluator.connect(target.webSocketDebuggerUrl);
  return { evaluator, port, target };
}
