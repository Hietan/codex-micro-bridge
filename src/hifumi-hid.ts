import { EventEmitter } from "node:events";
import * as HID from "node-hid";
import { isMicroKeyId, type DispatchRequest } from "./protocol.js";
import type { AgentStateProvider } from "./bridge.js";
import type { AgentSnapshot } from "./snapshot.js";

export const HIFUMI_VENDOR_ID = 0xfeed;
export const HIFUMI_PRODUCT_ID = 0x3060;
export const HIFUMI_USAGE_PAGE = 0xff60;
export const HIFUMI_USAGE = 0x61;
export const HIFUMI_REPORT_SIZE = 32;

const PACKET_HEADER_SIZE = 7;
const PROTOCOL_VERSION = 1;
const KEY_EVENT_TYPE = 1;
const STATUS_EVENT_TYPE = 0x80;

export interface ParsedCodexControlReport {
  sequence: number;
  request: DispatchRequest;
}

export interface HidDeviceInfo {
  vendorId: number;
  productId: number;
  path?: string | undefined;
  interface: number;
  usagePage?: number | undefined;
  usage?: number | undefined;
  product?: string | undefined;
}

export interface HidHandle extends EventEmitter {
  close(): Promise<void>;
  write(data: number[]): Promise<number>;
}

export interface HidBackend {
  devices(vendorId: number, productId: number): Promise<HidDeviceInfo[]>;
  open(path: string): Promise<HidHandle>;
}

export interface QmkRawHidOptions {
  logger?: (message: string) => void;
  reconnectDelayMs?: number;
  backend?: HidBackend;
  vendorId?: number;
  productId?: number;
  stateProvider?: AgentStateProvider;
  statusPollIntervalMs?: number;
}

export interface KeyDispatcher {
  dispatch(request: DispatchRequest): Promise<void>;
}

export class QmkRawHidAdapter {
  private handle: HidHandle | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<boolean> | undefined;
  private dispatchQueue = Promise.resolve();
  private closed = false;
  private readonly logger: (message: string) => void;
  private readonly reconnectDelayMs: number;
  private readonly backend: HidBackend;
  private readonly vendorId: number;
  private readonly productId: number;
  private readonly stateProvider: AgentStateProvider | undefined;
  private readonly statusPollIntervalMs: number;
  private statusTimer: NodeJS.Timeout | undefined;
  private statusPolling = false;
  private lastStatusReport: Buffer | undefined;

  constructor(
    private readonly dispatcher: KeyDispatcher,
    options: QmkRawHidOptions = {},
  ) {
    this.logger = options.logger ?? (() => undefined);
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.backend = options.backend ?? nodeHidBackend;
    this.vendorId = options.vendorId ?? HIFUMI_VENDOR_ID;
    this.productId = options.productId ?? HIFUMI_PRODUCT_ID;
    this.stateProvider = options.stateProvider;
    this.statusPollIntervalMs = options.statusPollIntervalMs ?? 750;
  }

  async start(): Promise<boolean> {
    if (this.closed) throw new Error("QMK Raw HID adapter has been closed.");
    return await this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    const handle = this.handle;
    this.handle = undefined;
    if (handle) await handle.close();
    await this.dispatchQueue;
  }

  private async connect(): Promise<boolean> {
    if (this.closed || this.handle) return Boolean(this.handle);
    if (this.connecting) return await this.connecting;
    this.connecting = this.openMatchingDevice();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async openMatchingDevice(): Promise<boolean> {
    try {
      const devices = await this.backend.devices(this.vendorId, this.productId);
      const device = selectCodexControlRawHidDevice(devices, this.vendorId, this.productId);
      if (!device?.path) {
        this.logger(`Codex Control Raw HID ${usbId(this.vendorId)}:${usbId(this.productId)} not found; waiting for device.`);
        this.scheduleReconnect();
        return false;
      }

      const handle = await this.backend.open(device.path);
      if (this.closed) {
        await handle.close();
        return false;
      }
      this.handle = handle;
      handle.on("data", (data: Buffer) => this.handleReport(data));
      handle.once("error", (error: Error) => void this.handleDeviceError(handle, error));
      this.logger(
        `Codex Control Raw HID connected (${usbId(device.vendorId)}:${usbId(device.productId)}, ${device.path}, usage ${hex(device.usagePage)}:${hex(device.usage)}).`,
      );
      this.startStatusPolling();
      return true;
    } catch (error) {
      this.logger(`Codex Control Raw HID connection failed: ${errorMessage(error)}`);
      this.scheduleReconnect();
      return false;
    }
  }

  private handleReport(data: Buffer): void {
    let parsed: ParsedCodexControlReport;
    try {
      parsed = parseCodexControlReport(data);
    } catch (error) {
      this.logger(`Ignored invalid Codex Control report: ${errorMessage(error)}`);
      return;
    }

    this.dispatchQueue = this.dispatchQueue
      .then(async () => {
        await this.dispatcher.dispatch(parsed.request);
        this.logger(
          `Codex Control ${describeRequest(parsed.request)} seq=${parsed.sequence} dispatched.`,
        );
      })
      .catch((error: unknown) => {
        this.logger(`Codex Control dispatch failed: ${errorMessage(error)}`);
      });
  }

  private async handleDeviceError(expected: HidHandle, error: Error): Promise<void> {
    if (this.handle !== expected) return;
    this.handle = undefined;
    this.lastStatusReport = undefined;
    this.logger(`Codex Control Raw HID disconnected: ${error.message}`);
    try {
      await expected.close();
    } catch (closeError) {
      this.logger(`Codex Control Raw HID close failed: ${errorMessage(closeError)}`);
    }
    this.scheduleReconnect();
  }

  private startStatusPolling(): void {
    if (!this.stateProvider || this.statusTimer) return;
    void this.pollStatus();
    this.statusTimer = setInterval(() => void this.pollStatus(), this.statusPollIntervalMs);
  }

  private async pollStatus(): Promise<void> {
    const handle = this.handle;
    if (!handle || !this.stateProvider || this.statusPolling) return;
    this.statusPolling = true;
    try {
      const report = buildStatusReport(await this.stateProvider.snapshot());
      if (!this.lastStatusReport?.equals(report)) {
        // node-hid requires a leading zero report ID for unnumbered HID reports.
        await handle.write([0, ...report]);
        this.lastStatusReport = report;
        this.logger("Codex Control Agent status synchronized.");
      }
    } catch (error) {
      this.logger(`Codex Control status sync failed: ${errorMessage(error)}`);
    } finally {
      this.statusPolling = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.reconnectDelayMs);
  }
}

export function selectCodexControlRawHidDevice(
  devices: readonly HidDeviceInfo[],
  vendorId = HIFUMI_VENDOR_ID,
  productId = HIFUMI_PRODUCT_ID,
): HidDeviceInfo | undefined {
  return devices.find(
    (device) =>
      device.vendorId === vendorId &&
      device.productId === productId &&
      device.usagePage === HIFUMI_USAGE_PAGE &&
      device.usage === HIFUMI_USAGE &&
      typeof device.path === "string" &&
      device.path.length > 0,
  );
}

export function parseCodexControlReport(data: Uint8Array): ParsedCodexControlReport {
  if (data.length !== HIFUMI_REPORT_SIZE) {
    throw new Error(`expected ${HIFUMI_REPORT_SIZE} bytes, received ${data.length}`);
  }
  if (data[0] !== 0x43 || data[1] !== 0x4d) throw new Error("invalid CM magic");
  if (data[2] !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version ${String(data[2])}`);
  if (data[3] === 2) return parseJoystickReport(data);
  if (data[3] !== KEY_EVENT_TYPE) throw new Error(`unsupported message type ${String(data[3])}`);

  const act = data[4];
  if (act !== 0 && act !== 1 && act !== 2) throw new Error(`invalid action ${String(act)}`);
  const sequence = data[5];
  const keyLength = data[6];
  if (sequence === undefined || keyLength === undefined) throw new Error("truncated packet header");
  if (keyLength === 0 || keyLength > HIFUMI_REPORT_SIZE - PACKET_HEADER_SIZE) {
    throw new Error(`invalid key length ${keyLength}`);
  }

  const keyBytes = data.slice(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + keyLength);
  if ([...keyBytes].some((byte) => byte < 0x21 || byte > 0x7e)) throw new Error("key is not printable ASCII");
  const key = Buffer.from(keyBytes).toString("ascii");
  if (!isMicroKeyId(key)) throw new Error(`unknown Codex Micro key ${key}`);
  const isEncoder = key === "ENC_CW" || key === "ENC_CC";
  if ((isEncoder && act !== 2) || (!isEncoder && act === 2)) {
    throw new Error(`invalid action ${act} for ${key}`);
  }
  const reserved = data.slice(PACKET_HEADER_SIZE + keyLength);
  if ([...reserved].some((byte) => byte !== 0)) throw new Error("reserved bytes must be zero");
  return { sequence, request: { v: 1, type: "key", key, act } };
}

export function buildStatusReport(snapshot: AgentSnapshot): Buffer {
  const report = Buffer.alloc(HIFUMI_REPORT_SIZE);
  report[0] = 0x43;
  report[1] = 0x4d;
  report[2] = 1;
  report[3] = STATUS_EVENT_TYPE;
  for (const slot of snapshot.slots) {
    if (!Number.isInteger(slot.id) || slot.id < 0 || slot.id > 5) continue;
    if (slot.selected) report[4] = (report[4] ?? 0) | (1 << slot.id);
    if (slot.threadKey || slot.status !== "off") report[5] = (report[5] ?? 0) | (1 << slot.id);
    report[6 + slot.id] = statusCode(slot.status);
  }
  return report;
}

export function statusCode(status: string): number {
  switch (status) {
    case "off": return 0;
    case "working":
    case "thinking": return 2;
    case "unread":
    case "complete":
    case "completed":
    case "done": return 3;
    case "approval":
    case "awaiting-approval":
    case "awaiting-response": return 4;
    case "error": return 5;
    default: return 1;
  }
}

const JOYSTICK_ANGLES = { 0: 0.75, 1: 0, 2: 0.25, 3: 0.5 } as const;

function parseJoystickReport(data: Uint8Array): ParsedCodexControlReport {
  const act = data[4];
  const sequence = data[5];
  const direction = data[6];
  if (act !== 0 && act !== 1) throw new Error(`invalid joystick action ${String(act)}`);
  if (sequence === undefined || direction === undefined || direction > 3) {
    throw new Error(`invalid joystick direction ${String(direction)}`);
  }
  if ([...data.slice(7)].some((byte) => byte !== 0)) throw new Error("reserved bytes must be zero");
  return {
    sequence,
    request: { v: 1, type: "joystick", angle: JOYSTICK_ANGLES[direction as keyof typeof JOYSTICK_ANGLES], distance: act },
  };
}

// Compatibility exports for early adopters of the hifumi-only API.
export const HifumiRawHidAdapter = QmkRawHidAdapter;
export const selectHifumiRawHidDevice = selectCodexControlRawHidDevice;
export const parseHifumiReport = parseCodexControlReport;

const nodeHidBackend: HidBackend = {
  async devices(vendorId, productId) {
    return await HID.devicesAsync(vendorId, productId);
  },
  async open(path) {
    return await HID.HIDAsync.open(path, { nonExclusive: true });
  },
};

function hex(value: number | undefined): string {
  return value === undefined ? "unknown" : value.toString(16).padStart(4, "0");
}

function usbId(value: number): string {
  return value.toString(16).padStart(4, "0");
}

function describeRequest(request: DispatchRequest): string {
  return request.type === "key"
    ? `${request.key} act=${request.act}`
    : `joystick angle=${request.angle} distance=${request.distance}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
