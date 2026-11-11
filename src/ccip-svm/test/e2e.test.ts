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
  "delivers an EVM-originated CCIP message into a Solana receiver",
  { timeout: 180_000, skip: !surfpoolAvailable() && "surfpool binary not available" },
  async () => {
    const sim = await CcipSvmLocal.start();
    try {
      const before = await sim.receiverCounterValue();
      const result = await sim.deliver({ data: "hello from ethereum" });
      const after = await sim.receiverCounterValue();

      assert.equal(after, before + 1n, "receiver must observe exactly one delivery");
      assert.match(result.messageId, /^[0-9a-f]{64}$/);
      assert.ok(result.signature.length > 0);
      assert.ok(result.resolutionTrace.includes("resolve_accounts_start"));
    } finally {
      await sim.stop();
    }
  },
);
