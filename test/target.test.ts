import assert from "node:assert/strict";
import test from "node:test";
import { parseDebugPortFromProcessList, selectCodexMainTarget } from "../src/target.js";

test("selects the primary app renderer", () => {
  const selected = selectCodexMainTarget([
    { type: "page", url: "app://codex/avatar-overlay", webSocketDebuggerUrl: "ws://overlay" },
    { type: "page", url: "app://codex/index.html?initialRoute=settings", webSocketDebuggerUrl: "ws://settings" },
    { type: "page", url: "app://codex/index.html", webSocketDebuggerUrl: "ws://main" },
    { type: "worker", url: "app://codex/index.html", webSocketDebuggerUrl: "ws://worker" },
  ]);
  assert.equal(selected?.webSocketDebuggerUrl, "ws://main");
});

test("extracts only loopback ChatGPT debug ports", () => {
  const safe = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=43123";
  const unsafe = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222";
  assert.equal(parseDebugPortFromProcessList(`${unsafe}\n${safe}`), 43123);
  assert.equal(parseDebugPortFromProcessList(unsafe), null);
});
