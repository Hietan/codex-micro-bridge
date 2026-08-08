import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  HIFUMI_PRODUCT_ID,
  HIFUMI_REPORT_SIZE,
  HIFUMI_USAGE,
  HIFUMI_USAGE_PAGE,
  HIFUMI_VENDOR_ID,
  QmkRawHidAdapter,
  buildStatusReport,
  parseCodexControlReport,
  statusCode,
  parseHifumiReport,
  selectHifumiRawHidDevice,
  type HidBackend,
  type HidHandle,
} from "../src/hifumi-hid.js";
import type { DispatchRequest } from "../src/protocol.js";

test("parses an hifumi key report", () => {
  const report = makeReport("ACT06", 1, 42);
  assert.deepEqual(parseHifumiReport(report), {
    sequence: 42,
    request: { v: 1, type: "key", key: "ACT06", act: 1 },
  });
});

test("accepts encoder steps and rejects incompatible actions", () => {
  const parsed = parseHifumiReport(makeReport("ENC_CC", 2, 1)).request;
  assert.equal(parsed.type, "key");
  if (parsed.type === "key") assert.equal(parsed.key, "ENC_CC");
  assert.throws(() => parseHifumiReport(makeReport("ENC_CC", 1, 1)), /invalid action/);
  assert.throws(() => parseHifumiReport(makeReport("ACT07", 2, 1)), /invalid action/);
});

test("parses all four QMK joystick directions", () => {
  const expectedAngles = [0.75, 0, 0.25, 0.5];
  for (let direction = 0; direction < 4; direction += 1) {
    assert.deepEqual(parseCodexControlReport(makeJoystickReport(direction, 1, direction)).request, {
      v: 1,
      type: "joystick",
      angle: expectedAngles[direction],
      distance: 1,
    });
  }
  assert.equal(parseCodexControlReport(makeJoystickReport(0, 0, 4)).request.type, "joystick");
  assert.throws(() => parseCodexControlReport(makeJoystickReport(4, 1, 0)), /invalid joystick direction/);
});

test("accepts agent slot reports without embedding desktop task ids in firmware", () => {
  assert.deepEqual(parseCodexControlReport(makeReport("AG05", 1, 8)).request, {
    v: 1,
    type: "key",
    key: "AG05",
    act: 1,
  });
});

test("encodes selected, assigned, and normalized Agent status in one output report", () => {
  const report = buildStatusReport({
    slots: [
      { id: 0, threadKey: "a", status: "working", selected: true },
      { id: 1, threadKey: "b", status: "unread", selected: false },
      { id: 2, threadKey: "c", status: "awaiting-approval", selected: false },
      { id: 3, threadKey: "d", status: "error", selected: false },
      { id: 4, threadKey: "e", status: "idle", selected: false },
      { id: 5, threadKey: null, status: "off", selected: false },
    ],
  });
  assert.equal(report.length, 32);
  assert.deepEqual([...report.slice(0, 12)], [0x43, 0x4d, 1, 0x80, 0b000001, 0b011111, 2, 3, 4, 5, 1, 0]);
  assert.ok(report.slice(12).every((byte) => byte === 0));
});

test("normalizes every documented native Agent state", () => {
  assert.equal(statusCode("off"), 0);
  assert.equal(statusCode("idle"), 1);
  assert.equal(statusCode("working"), 2);
  assert.equal(statusCode("thinking"), 2);
  for (const value of ["unread", "complete", "completed", "done"]) assert.equal(statusCode(value), 3);
  for (const value of ["approval", "awaiting-approval", "awaiting-response"]) assert.equal(statusCode(value), 4);
  assert.equal(statusCode("error"), 5);
});

test("rejects malformed and non-allowlisted reports", () => {
  assert.throws(() => parseHifumiReport(Buffer.alloc(31)), /expected 32 bytes/);

  const badMagic = makeReport("ACT06", 1, 0);
  badMagic[0] = 0;
  assert.throws(() => parseHifumiReport(badMagic), /invalid CM magic/);

  const unknown = makeReport("NOPE", 1, 0);
  assert.throws(() => parseHifumiReport(unknown), /unknown Codex Micro key/);

  const reserved = makeReport("ACT06", 1, 0);
  reserved[31] = 1;
  assert.throws(() => parseHifumiReport(reserved), /reserved bytes/);
});

test("selects only the hifumi vendor-defined Raw HID interface", () => {
  const keyboard = device(1, 6, "keyboard");
  const rawHid = device(HIFUMI_USAGE_PAGE, HIFUMI_USAGE, "raw-hid");
  assert.equal(selectHifumiRawHidDevice([keyboard, rawHid])?.path, "raw-hid");
});

test("adapter forwards reports in arrival order", async () => {
  const handle = new FakeHandle();
  const backend: HidBackend = {
    async devices() {
      return [device(HIFUMI_USAGE_PAGE, HIFUMI_USAGE, "raw-hid")];
    },
    async open(path) {
      assert.equal(path, "raw-hid");
      return handle;
    },
  };
  const events: DispatchRequest[] = [];
  const adapter = new QmkRawHidAdapter(
    { async dispatch(request) { events.push(request); } },
    { backend, reconnectDelayMs: 5 },
  );

  assert.equal(await adapter.start(), true);
  handle.emit("data", makeReport("ACT10", 1, 3));
  handle.emit("data", makeReport("ACT10", 0, 4));
  await adapter.close();

  assert.deepEqual(events.filter((event) => event.type === "key").map(({ key, act }) => ({ key, act })), [
    { key: "ACT10", act: 1 },
    { key: "ACT10", act: 0 },
  ]);
  assert.equal(handle.closed, true);
});

class FakeHandle extends EventEmitter implements HidHandle {
  closed = false;
  writes: number[][] = [];

  async write(data: number[]): Promise<number> {
    this.writes.push(data);
    return data.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.removeAllListeners();
  }
}

function makeJoystickReport(direction: number, act: number, sequence: number): Buffer {
  const report = Buffer.alloc(HIFUMI_REPORT_SIZE);
  report[0] = 0x43;
  report[1] = 0x4d;
  report[2] = 1;
  report[3] = 2;
  report[4] = act;
  report[5] = sequence;
  report[6] = direction;
  return report;
}

function makeReport(key: string, act: number, sequence: number): Buffer {
  const report = Buffer.alloc(HIFUMI_REPORT_SIZE);
  report[0] = 0x43;
  report[1] = 0x4d;
  report[2] = 1;
  report[3] = 1;
  report[4] = act;
  report[5] = sequence;
  report[6] = key.length;
  report.write(key, 7, "ascii");
  return report;
}

function device(usagePage: number, usage: number, path: string) {
  return {
    vendorId: HIFUMI_VENDOR_ID,
    productId: HIFUMI_PRODUCT_ID,
    interface: usagePage === HIFUMI_USAGE_PAGE ? 1 : 0,
    usagePage,
    usage,
    path,
  };
}
