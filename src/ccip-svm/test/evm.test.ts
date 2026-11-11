import assert from "node:assert/strict";
import test from "node:test";

import { deliverToEvm, toAny2EvmMessage } from "../src/evm.js";
import { decodeMessage, encodeMessage, encodeTokenTransfer, messageId } from "../src/codec.js";

const RECEIVER = "0x00000000000000000000000000000000000000aa";

function stubRouter() {
  const calls: unknown[][] = [];
  return {
    calls,
    async routeMessage(...args: unknown[]) {
      calls.push(args);
      return { hash: "0xdeadbeef" };
    },
  };
}

test("deliverToEvm forwards the message and returns the tx hash", async () => {
  const router = stubRouter();
  const message = {
    messageId: `0x${"11".repeat(32)}`,
    sourceChainSelector: 16423721717087811551n,
    sender: "0x0202",
    data: "0x6869",
    destTokenAmounts: [],
  };

  const result = await deliverToEvm({ router, message, receiver: RECEIVER });
  assert.equal(result.hash, "0xdeadbeef");
  assert.equal(router.calls.length, 1);
  assert.deepEqual(router.calls[0][0], message);
  assert.equal(router.calls[0][3], RECEIVER);
});

test("deliverToEvm rejects a malformed receiver", async () => {
  const router = stubRouter();
  await assert.rejects(
    deliverToEvm({ router, message: {} as never, receiver: "0x1234" }),
    /invalid EVM receiver/,
  );
  assert.equal(router.calls.length, 0);
});

test("toAny2EvmMessage maps a decoded data-only message", () => {
  const encoded = encodeMessage({
    sourceChainSelector: 16423721717087811551n,
    destChainSelector: 16015286601757825753n,
    messageNumber: 1n,
    executionGasLimit: 200_000,
    ccipReceiveGasLimit: 0,
    onRampAddress: Buffer.alloc(32, 1),
    offRampAddress: Buffer.alloc(20, 2),
    sender: Buffer.alloc(32, 3),
    receiver: Buffer.alloc(20, 4),
    destBlob: Buffer.alloc(0),
    data: Buffer.from("hello"),
  });

  const decoded = decodeMessage(encoded);
  const message = toAny2EvmMessage(decoded, `0x${messageId(encoded).toString("hex")}`);
  assert.equal(message.sourceChainSelector, 16423721717087811551n);
  assert.equal(message.sender, `0x${"03".repeat(32)}`);
  assert.equal(message.data, `0x${Buffer.from("hello").toString("hex")}`);
  assert.deepEqual(message.destTokenAmounts, []);
});

test("toAny2EvmMessage requires a token mapping when tokens move", () => {
  const encoded = encodeMessage({
    sourceChainSelector: 1n,
    destChainSelector: 2n,
    messageNumber: 1n,
    executionGasLimit: 1,
    ccipReceiveGasLimit: 0,
    onRampAddress: Buffer.alloc(32),
    offRampAddress: Buffer.alloc(20),
    sender: Buffer.alloc(32),
    receiver: Buffer.alloc(20),
    destBlob: Buffer.alloc(0),
    tokenTransfer: encodeTokenTransfer({
      amount: 1n,
      sourcePoolAddress: Buffer.alloc(20),
      sourceTokenAddress: Buffer.alloc(20),
      destTokenAddress: Buffer.alloc(32),
      tokenReceiver: Buffer.alloc(32),
    }),
    data: Buffer.alloc(0),
  });

  assert.throws(
    () => toAny2EvmMessage(decodeMessage(encoded), `0x${"00".repeat(32)}`),
    /carries a token transfer/,
  );
});
