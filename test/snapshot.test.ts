import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentSnapshotExpression, validateAgentSnapshot } from "../src/snapshot.js";

test("snapshot expression discovers native six-slot signals without reading task content", () => {
  const expression = buildAgentSnapshotExpression();
  assert.match(expression, /codex-micro-slot-signals-/);
  assert.match(expression, /candidate\.length === 6/);
  assert.match(expression, /data-app-action-sidebar-thread-id/);
  assert.doesNotMatch(expression, /prompt|response|message\.content/);
});

test("validates a bounded six-slot snapshot", () => {
  const value = {
    slots: Array.from({ length: 6 }, (_, id) => ({
      id,
      threadKey: id === 0 ? "thread" : null,
      status: id === 0 ? "working" : "off",
      selected: id === 0,
    })),
  };
  assert.deepEqual(validateAgentSnapshot(value), value);
  assert.throws(() => validateAgentSnapshot({ slots: value.slots.slice(0, 5) }), /exactly six/);
  assert.throws(() => validateAgentSnapshot({ slots: [{ id: 2 }] }), /slot 0/);
});
