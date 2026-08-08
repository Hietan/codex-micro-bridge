import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockBridge } from "../src/bridge.js";
import { sendBridgeRequest } from "../src/client.js";
import { BridgeServer } from "../src/server.js";

test("local socket dispatches a validated event and acknowledges it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-micro-bridge-test-"));
  const socketPath = join(directory, "bridge.sock");
  const bridge = new MockBridge();
  const server = new BridgeServer(bridge, { socketPath });
  try {
    const probe = await server.start();
    assert.equal(probe.mode, "mock");
    const result = await sendBridgeRequest(socketPath, {
      v: 1,
      id: "event-1",
      type: "key",
      key: "ACT06",
      act: 1,
    });
    assert.equal(result.ready.mode, "mock");
    assert.deepEqual(result.response, { v: 1, type: "ack", id: "event-1", status: "dispatched" });
    assert.equal(bridge.events.length, 1);

    const snapshot = await sendBridgeRequest(socketPath, {
      v: 1,
      id: "state-1",
      type: "snapshot",
    });
    assert.equal(snapshot.response.type, "snapshot");
    if (snapshot.response.type === "snapshot") {
      assert.equal(snapshot.response.id, "state-1");
      assert.equal(snapshot.response.slots.length, 6);
      assert.deepEqual(snapshot.response.slots[0], {
        id: 0,
        assigned: true,
        status: "working",
        selected: true,
      });
      assert.equal("threadKey" in snapshot.response.slots[0]!, false);
    }
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
