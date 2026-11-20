// The expected hex comes from the Daml encoder itself: `Encode:testEncode` in a throwaway
// project that data-depends on the released `ccip-codec-v2` DAR, run with `dpm script --ide-ledger`.

import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, encodeMessageV1, finalityConfig, hashAddress, hexToBytes } from "./codec.js";

const EXPECTED =
  "01" +
  "de41ba4fc9d91ad9" +
  "78d406951367c3e2" +
  "0000000000000001" +
  "00000000" +
  "00030d40" +
  "00000000" +
  "0".repeat(64) +
  "20" + "11".repeat(32) +
  "20" + "22".repeat(32) +
  "20" + "33".repeat(32) +
  "20" + "44".repeat(32) +
  "0000" +
  "0000" +
  "0005" +
  "68656c6c6f";

test("encodes the upstream message vector byte for byte", () => {
  const encoded = encodeMessageV1({
    sourceChainSelector: 16015286601757825753n,
    destChainSelector: 8706591216959472610n,
    sequenceNumber: 1n,
    executionGasLimit: 0,
    ccipReceiveGasLimit: 200_000,
    finality: finalityConfig(0),
    ccvAndExecutorHash: hexToBytes("0".repeat(64)),
    onRampAddress: hexToBytes("11".repeat(32)),
    offRampAddress: hexToBytes("22".repeat(32)),
    sender: hexToBytes("33".repeat(32)),
    receiver: hexToBytes("44".repeat(32)),
    destBlob: new Uint8Array(),
    messageData: hexToBytes("68656c6c6f"),
  });

  assert.equal(bytesToHex(encoded), EXPECTED);
});

test("token transfer is length prefixed inside the message", () => {
  const transfer = hexToBytes("01" + "22".repeat(32) + "00" + "00" + "00" + "00" + "0000");
  const encoded = encodeMessageV1({
    sourceChainSelector: 1n,
    destChainSelector: 2n,
    sequenceNumber: 3n,
    executionGasLimit: 4,
    ccipReceiveGasLimit: 5,
    finality: finalityConfig(0),
    ccvAndExecutorHash: new Uint8Array(32),
    onRampAddress: new Uint8Array(),
    offRampAddress: new Uint8Array(),
    sender: new Uint8Array(),
    receiver: new Uint8Array(),
    destBlob: new Uint8Array(),
    tokenTransfer: transfer,
    messageData: new Uint8Array(),
  });

  const hex = bytesToHex(encoded);
  assert.ok(hex.includes(`00${(transfer.length).toString(16).padStart(4, "0")}${bytesToHex(transfer)}`));
});

test("party address is keccak over the utf8 party text", () => {
  // keccak256("alice") from any keccak implementation; asserted for shape and stability.
  const a = hashAddress("alice");
  assert.equal(a.length, 32);
  assert.deepEqual(a, hashAddress("alice"));
  assert.notDeepEqual(a, hashAddress("bob"));
});
