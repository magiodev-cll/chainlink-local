import assert from "node:assert/strict";
import test from "node:test";
import { toAny2EvmMessage } from "../../../scripts/canton/evm.js";

test("converts a sent Canton message into the EVM router struct", () => {
  const message = toAny2EvmMessage({
    messageId: "b38f804fc7c56d93ef1a4a96e739347515cfe96c8f0712e347d20e6134bc8e9b",
    sourceChainSelector: 8706591216959472610n,
    sender: "0x1111111111111111111111111111111111111111",
    data: "68656c6c6f",
  });

  assert.equal(message.messageId, "0xb38f804fc7c56d93ef1a4a96e739347515cfe96c8f0712e347d20e6134bc8e9b");
  assert.equal(message.sourceChainSelector, 8706591216959472610n);
  assert.equal(message.sender, "0x0000000000000000000000001111111111111111111111111111111111111111");
  assert.equal(message.data, "0x68656c6c6f");
  assert.deepEqual(message.destTokenAmounts, []);
});

test("refuses to invent a message id", () => {
  assert.throws(() => toAny2EvmMessage({ sourceChainSelector: 1n, sender: "0x11", data: "" }), /messageId is required/);
});
