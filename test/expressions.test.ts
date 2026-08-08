import assert from "node:assert/strict";
import test from "node:test";
import { retainEvaluationPromise } from "../src/cdp-client.js";
import { buildDispatchExpression } from "../src/expressions.js";

test("dispatch expression contains only serialized allowlisted payload", () => {
  const expression = buildDispatchExpression(
    {
      type: "codex-micro-hid-event",
      event: { key: "ACT06", act: 1, slot: null, threadKey: null },
    },
    "codex-micro-hid-event",
  );
  assert.match(expression, /codex-micro-device-state-changed/);
  assert.match(expression, /codex-micro-hid-event/);
  assert.match(expression, /ACT06/);
  assert.match(expression, /dispatch\.call/);
});

test("retains pending CDP promises in the renderer", () => {
  const expression = retainEvaluationPromise("Promise.resolve(42)", "test");
  assert.match(expression, /__codexMicroBridgePendingEvaluations/);
  assert.match(expression, /codex-micro-bridge-test/);
});
