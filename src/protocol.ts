export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export const MICRO_KEY_IDS = [
  "AG00",
  "AG01",
  "AG02",
  "AG03",
  "AG04",
  "AG05",
  "ACT06",
  "ACT07",
  "ACT08",
  "ACT09",
  "ACT10",
  "ACT11",
  "ACT12",
  "ENC",
  "ENC_CW",
  "ENC_CC",
] as const;

export type MicroKeyId = (typeof MICRO_KEY_IDS)[number];
export type MicroKeyAct = 0 | 1 | 2;

export interface HelloRequest {
  v: 1;
  id?: string;
  type: "hello";
  deviceId?: string;
  capabilities?: string[];
}

export interface PingRequest {
  v: 1;
  id?: string;
  type: "ping";
}

export interface SnapshotRequest {
  v: 1;
  id?: string;
  type: "snapshot";
}

export interface KeyRequest {
  v: 1;
  id?: string;
  type: "key";
  key: MicroKeyId;
  act: MicroKeyAct;
  threadKey?: string;
}

export interface JoystickRequest {
  v: 1;
  id?: string;
  type: "joystick";
  angle: number;
  distance: number;
}

export type BridgeRequest = HelloRequest | PingRequest | SnapshotRequest | KeyRequest | JoystickRequest;
export type DispatchRequest = KeyRequest | JoystickRequest;

export interface ReadyResponse {
  v: 1;
  type: "ready";
  mode: "codex" | "mock";
  target?: string;
  port?: number;
}

export interface AckResponse {
  v: 1;
  type: "ack";
  id?: string;
  status: "ready" | "dispatched";
}

export interface ErrorResponse {
  v: 1;
  type: "error";
  id?: string;
  error: {
    code: string;
    message: string;
  };
}

export interface SnapshotResponse {
  v: 1;
  type: "snapshot";
  id?: string;
  slots: Array<{
    id: number;
    assigned: boolean;
    status: string;
    selected: boolean;
  }>;
}

export type BridgeResponse = ReadyResponse | AckResponse | ErrorResponse | SnapshotResponse;

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

const KEY_ID_SET = new Set<string>(MICRO_KEY_IDS);
const AGENT_KEY_PATTERN = /^AG0([0-5])$/;

export function isMicroKeyId(value: unknown): value is MicroKeyId {
  return typeof value === "string" && KEY_ID_SET.has(value);
}

export function agentSlotForKey(key: MicroKeyId): number | null {
  const match = AGENT_KEY_PATTERN.exec(key);
  return match ? Number(match[1]) : null;
}

export function parseBridgeRequest(value: unknown): BridgeRequest {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid_request", "Request must be a JSON object.");
  }
  if (value.v !== BRIDGE_PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported_version", "Only bridge protocol version 1 is supported.");
  }
  const id = optionalString(value.id, "id", 200);

  if (value.type === "hello") {
    const capabilities = value.capabilities;
    if (capabilities !== undefined && (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === "string"))) {
      throw new ProtocolError("invalid_capabilities", "capabilities must be an array of strings.");
    }
    return {
      v: 1 as const,
      type: "hello" as const,
      ...(id === undefined ? {} : { id }),
      ...optionalProperty("deviceId", optionalString(value.deviceId, "deviceId", 200)),
      ...(capabilities === undefined ? {} : { capabilities: capabilities as string[] }),
    };
  }

  if (value.type === "ping") {
    return { v: 1, type: "ping", ...(id === undefined ? {} : { id }) };
  }

  if (value.type === "snapshot") {
    return { v: 1, type: "snapshot", ...(id === undefined ? {} : { id }) };
  }

  if (value.type === "key") {
    if (!isMicroKeyId(value.key)) {
      throw new ProtocolError("invalid_key", `Unknown Codex Micro key: ${String(value.key)}`);
    }
    if (value.act !== 0 && value.act !== 1 && value.act !== 2) {
      throw new ProtocolError("invalid_act", "act must be 0 (release), 1 (press), or 2 (encoder step).");
    }
    const isEncoderStep = value.key === "ENC_CW" || value.key === "ENC_CC";
    if ((isEncoderStep && value.act !== 2) || (!isEncoderStep && value.act === 2)) {
      throw new ProtocolError("invalid_key_act", "act=2 is valid only for ENC_CW and ENC_CC; those keys require act=2.");
    }
    const threadKey = optionalString(value.threadKey, "threadKey", 2000);
    return {
      v: 1,
      type: "key",
      ...(id === undefined ? {} : { id }),
      key: value.key,
      act: value.act,
      ...(threadKey === undefined ? {} : { threadKey }),
    };
  }

  if (value.type === "joystick") {
    const angle = finiteNumber(value.angle, "angle");
    const distance = finiteNumber(value.distance, "distance");
    if (angle < 0 || angle > 1) {
      throw new ProtocolError("invalid_angle", "angle must be between 0 and 1.");
    }
    if (distance < 0 || distance > 1) {
      throw new ProtocolError("invalid_distance", "distance must be between 0 and 1.");
    }
    return { v: 1, type: "joystick", ...(id === undefined ? {} : { id }), angle, distance };
  }

  throw new ProtocolError("unknown_type", `Unknown request type: ${String(value.type)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ProtocolError(`invalid_${name}`, `${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`invalid_${name}`, `${name} must be a finite number.`);
  }
  return value;
}

function optionalProperty<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
