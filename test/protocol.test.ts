import assert from "node:assert/strict";
import test from "node:test";
import { MICRO_KEY_IDS, ProtocolError, agentSlotForKey, parseBridgeRequest } from "../src/protocol.js";

test("parses a command key press", () => {
  assert.deepEqual(parseBridgeRequest({ v: 1, id: "a", type: "key", key: "ACT06", act: 1 }), {
    v: 1,
    id: "a",
    type: "key",
    key: "ACT06",
    act: 1,
  });
});

test("accepts device-slot agent keys without a manually supplied thread id", () => {
  assert.deepEqual(parseBridgeRequest({ v: 1, type: "key", key: "AG00", act: 1 }), {
    v: 1,
    type: "key",
    key: "AG00",
    act: 1,
  });
  assert.equal(agentSlotForKey("AG05"), 5);
});

test("accepts only encoder step semantics", () => {
  assert.throws(
    () => parseBridgeRequest({ v: 1, type: "key", key: "ACT06", act: 2 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_key_act",
  );
  assert.equal(parseBridgeRequest({ v: 1, type: "key", key: "ENC_CW", act: 2 }).type, "key");
});

test("validates joystick ranges", () => {
  assert.throws(
    () => parseBridgeRequest({ v: 1, type: "joystick", angle: 1.2, distance: 1 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_angle",
  );
});

test("accepts a bounded status snapshot request", () => {
  assert.deepEqual(parseBridgeRequest({ v: 1, id: "state-1", type: "snapshot" }), {
    v: 1,
    id: "state-1",
    type: "snapshot",
  });
});

test("accepts both edge states for every physical key and step semantics for both dial directions", () => {
  assert.equal(MICRO_KEY_IDS.length, 16);
  for (const key of MICRO_KEY_IDS) {
    if (key === "ENC_CW" || key === "ENC_CC") {
      assert.deepEqual(parseBridgeRequest({ v: 1, type: "key", key, act: 2 }), {
        v: 1,
        type: "key",
        key,
        act: 2,
      });
      continue;
    }
    for (const act of [0, 1] as const) {
      assert.deepEqual(parseBridgeRequest({ v: 1, type: "key", key, act }), {
        v: 1,
        type: "key",
        key,
        act,
      });
    }
  }
});
