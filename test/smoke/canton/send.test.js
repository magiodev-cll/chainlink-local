// Local mode, outbound: the adapter opens the destination lane lazily on the first send.
// Needs the Daml SDK (`dpm install 3.4.11`) and JAVA_HOME, like the delivery test.

import assert from "node:assert/strict";
import test from "node:test";
import {
  CANTON_LOCALNET_SELECTOR,
  ETHEREUM_SEPOLIA_SELECTOR,
  startCantonLocal,
} from "../../../scripts/canton/index.js";

test("opens the destination lane and sends a message", { timeout: 300_000 }, async () => {
  const canton = await startCantonLocal();
  try {
    const sent = await canton.send({
      // A 20-byte EVM address, ABI padded to the 32-byte word the lane expects.
      receiver: `${"00".repeat(12)}${"44".repeat(20)}`,
      payload: Buffer.from("hello evm").toString("hex"),
    });

    // The wire message itself, not just a new router id.
    assert.match(sent.messageId, /^[0-9a-f]{64}$/);
    assert.match(sent.encodedMessage, /^[0-9a-f]+$/);
    assert.equal(sent.encodedMessage.slice(0, 2), "01", "message version");
    assert.equal(BigInt(`0x${sent.encodedMessage.slice(2, 18)}`), BigInt(CANTON_LOCALNET_SELECTOR));
    assert.equal(BigInt(`0x${sent.encodedMessage.slice(18, 34)}`), BigInt(ETHEREUM_SEPOLIA_SELECTOR));
    assert.ok(
      sent.encodedMessage.includes(Buffer.from("hello evm").toString("hex")),
      "payload is carried",
    );
  } finally {
    await canton.stop();
  }
});
