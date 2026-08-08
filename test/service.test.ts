import assert from "node:assert/strict";
import test from "node:test";
import { buildLaunchAgentPlist, servicePaths } from "../src/service.js";

test("builds a login service with absolute runtime paths and reconnect options", () => {
  const plist = buildLaunchAgentPlist({
    nodePath: "/opt/node & tools/bin/node",
    cliPath: "/Users/test/codex-control/dist/src/cli.js",
    port: 9222,
    vendorId: 0xcafe,
    productId: 0x4001,
    launchChatGpt: true,
    home: "/Users/test",
  });
  assert.match(plist, /<string>dev\.codex-control\.bridge<\/string>/);
  assert.match(plist, /<string>\/opt\/node &amp; tools\/bin\/node<\/string>/);
  assert.match(plist, /<string>--wait<\/string>/);
  assert.match(plist, /<string>9222<\/string>/);
  assert.match(plist, /<string>cafe<\/string>/);
  assert.match(plist, /<string>4001<\/string>/);
  assert.match(plist, /<string>--launch-chatgpt<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s+<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s+<true\/>/);
});

test("uses the per-user LaunchAgents and Logs directories", () => {
  assert.deepEqual(servicePaths("/Users/test"), {
    plist: "/Users/test/Library/LaunchAgents/dev.codex-control.bridge.plist",
    stdout: "/Users/test/Library/Logs/CodexControlBridge.log",
    stderr: "/Users/test/Library/Logs/CodexControlBridge.error.log",
  });
});

test("requires a stable port when the service owns ChatGPT launch", () => {
  assert.throws(
    () => buildLaunchAgentPlist({ nodePath: "/node", cliPath: "/cli", launchChatGpt: true }),
    /explicit CDP port/,
  );
});
