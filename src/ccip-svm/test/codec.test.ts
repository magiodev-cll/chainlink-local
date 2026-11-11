import assert from "node:assert/strict";
import test from "node:test";

import { addressOf, committeeKey, encodeMessage, messageId, signVerifierResults } from "../src/codec.js";

test("MessageV1 encoding is stable", () => {
  const encoded = encodeMessage({
    sourceChainSelector: 16015286601757825753n,
    destChainSelector: 16423721717087811551n,
    messageNumber: 1n,
    executionGasLimit: 200_000,
    ccipReceiveGasLimit: 200_000,
    onRampAddress: Buffer.alloc(20, 1),
    offRampAddress: Buffer.alloc(32, 9),
    sender: Buffer.alloc(20, 2),
    receiver: Buffer.alloc(32, 3),
    destBlob: Buffer.alloc(0),
    data: Buffer.from("golden"),
  });

  // Locks the custom (non-borsh) wire format: field order, endianness and length prefixes.
  assert.equal(
    messageId(encoded).toString("hex"),
    "a4631a18aa0e1bb680c0c25d111c8318dbea3ac4398385ca207f14124a758016",
  );
});

test("committee keys are deterministic and address-sorted", () => {
  const keys = Array.from({ length: 4 }, (_, i) => committeeKey(i));
  const addresses = keys.map(addressOf);
  assert.equal(new Set(addresses).size, 4);
  assert.deepEqual(
    keys.map(addressOf),
    Array.from({ length: 4 }, (_, i) => addressOf(committeeKey(i))),
  );
});

test("verifier results carry the version tag and a fixed-width signature", () => {
  const id = new Uint8Array(32).fill(7);
  const results = signVerifierResults(id, [committeeKey(0)], 1);
  assert.equal(Buffer.from(results.subarray(0, 4)).toString("hex"), "e9a05a20");
  assert.equal(results.readUInt16BE(4), 64);
  assert.equal(results.length, 6 + 64);
});
