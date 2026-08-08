import assert from "node:assert/strict";
import test from "node:test";
import { chatGptLaunchArguments } from "../src/chatgpt-launcher.js";

test("launches ChatGPT in the background with loopback-only CDP", () => {
  assert.deepEqual(chatGptLaunchArguments(9222), [
    "-gj",
    "-a",
    "ChatGPT",
    "--args",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
  ]);
  assert.throws(() => chatGptLaunchArguments(0), /valid explicit CDP port/);
});
