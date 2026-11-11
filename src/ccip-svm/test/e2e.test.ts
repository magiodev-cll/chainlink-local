import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { CcipSvmLocal } from "../src/index.js";

function surfpoolAvailable(): boolean {
  const bin = process.env.SURFPOOL_BIN ?? "surfpool";
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test(
  "delivers EVM-originated messages and tokens into a Solana receiver",
  { timeout: 300_000, skip: !surfpoolAvailable() && "surfpool binary not available" },
  async () => {
    const sim = await CcipSvmLocal.start();
    try {
      const dataResult = await sim.deliver({ data: "hello from ethereum" });
      assert.equal(await sim.receiverCounterValue(), 1n);
      assert.match(dataResult.messageId, /^[0-9a-f]{64}$/);
      assert.ok(dataResult.resolutionTrace.includes("resolve_accounts_start"));

      const { mint } = await sim.createBurnMintToken({ initialSupply: 1_000n });
      const ata = sim.tokenAccountFor(mint);
      const tokenResult = await sim.deliver({
        data: "tokens from ethereum",
        token: { mint, amount: 7n },
      });

      assert.equal(await sim.receiverCounterValue(), 2n);
      const balance = await sim.connection.getTokenAccountBalance(ata, "confirmed");
      assert.equal(balance.value.amount, "1007"); // seeded supply + delivered amount
      assert.ok(tokenResult.resolutionTrace.includes("resolve_accounts_execute_token_transfer_retrieve_lut_stage"));

      // Outbound: a real Router send on the local EVM lane.
      const sent = await sim.send({ receiver: Buffer.alloc(20, 0xab), data: "hello evm" });
      assert.match(sent.messageId ?? "", /^[0-9a-f]{64}$/);
      assert.ok(sent.signature.length > 0);
    } finally {
      await sim.stop();
    }
  },
);
