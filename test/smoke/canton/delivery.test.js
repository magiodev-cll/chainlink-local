// Local mode: a real Canton participant, the real CCIP contracts, a delivered message.
// Needs the Daml SDK (`dpm install 3.4.11`) and JAVA_HOME, because the sandbox is the SDK's daemon.

import assert from "node:assert/strict";
import test from "node:test";
import { startCantonLocal } from "../../../scripts/canton/index.js";

const PAYLOAD = "hello from ethereum";

test("delivers data and tokens through the real OffRamp", { timeout: 300_000 }, async () => {
  const canton = await startCantonLocal();
  try {
    const result = await canton.deliver({ data: Buffer.from(PAYLOAD).toString("hex") });

    assert.match(result.messageId, /^0x[0-9a-f]{64}$/);
    // The receiver returns a CCIPMessageReceived contract the application can read.
    assert.ok(result.messageReceived);
    assert.equal(result.holding, undefined, "a data-only message moves no tokens");

    // Same path, now carrying 7 tokens at the instrument's 10 decimals.
    const withToken = await canton.deliver({
      token: { amount: 7n * 10n ** 10n },
      data: Buffer.from("tokens").toString("hex"),
    });

    assert.ok(withToken.messageReceived);
    assert.notEqual(withToken.messageId, result.messageId);
    // Settlement actually moves value: the pool releases the ticket into a holding.
    assert.ok(withToken.holding, "no holding created");
    assert.equal(Number(withToken.holding.amount), 7);
    assert.equal(withToken.holding.owner, canton.party);
  } finally {
    await canton.stop();
  }
});
