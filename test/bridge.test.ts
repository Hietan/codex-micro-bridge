import assert from "node:assert/strict";
import test from "node:test";
import { CodexMicroBridge, type ConnectedSession } from "../src/bridge.js";
import type { RuntimeEvaluator } from "../src/cdp-client.js";

class FakeEvaluator implements RuntimeEvaluator {
  readonly expressions: string[] = [];
  closed = false;

  async evaluate<T>(expression: string): Promise<T> {
    this.expressions.push(expression);
    if (expression.includes("hidHandlers:")) {
      return {
        hidHandlers: 1,
        joystickHandlers: 1,
        href: "app://codex/index.html",
      } as T;
    }
    if (expression.includes("codex-micro-slot-signals-")) {
      return {
        slots: Array.from({ length: 6 }, (_, id) => ({
          id,
          threadKey: `thread-${id}`,
          status: "idle",
          selected: id === 0,
        })),
      } as T;
    }
    return true as T;
  }

  close(): void {
    this.closed = true;
  }
}

test("bridge converts allowlisted requests to native renderer messages", async () => {
  const evaluator = new FakeEvaluator();
  const session: ConnectedSession = {
    evaluator,
    port: 43123,
    target: {
      type: "page",
      url: "app://codex/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/main",
    },
  };
  const bridge = new CodexMicroBridge({ connector: async () => session });

  assert.deepEqual(await bridge.probe(), {
    mode: "codex",
    target: "app://codex/index.html",
    port: 43123,
    hidHandlers: 1,
    joystickHandlers: 1,
  });
  await bridge.dispatch({ v: 1, type: "key", key: "ACT06", act: 1 });
  await bridge.dispatch({ v: 1, type: "key", key: "AG00", act: 1 });
  await bridge.dispatch({ v: 1, type: "joystick", angle: 0.75, distance: 1 });

  assert.match(evaluator.expressions[1] ?? "", /"type":"codex-micro-hid-event"/);
  assert.match(evaluator.expressions[1] ?? "", /"key":"ACT06"/);
  assert.match(evaluator.expressions[2] ?? "", /codex-micro-slot-signals-/);
  assert.match(evaluator.expressions[3] ?? "", /"key":"AG00"/);
  assert.match(evaluator.expressions[3] ?? "", /"slot":0/);
  assert.match(evaluator.expressions[3] ?? "", /"threadKey":"thread-0"/);
  assert.match(evaluator.expressions[4] ?? "", /"type":"codex-micro-joystick-event"/);
  assert.match(evaluator.expressions[4] ?? "", /"angle":0\.75/);
  bridge.close();
  assert.equal(evaluator.closed, true);
});
