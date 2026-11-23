// Local mode: a real Canton participant, the real CCIP contracts, a delivered message.
// Needs the Daml SDK (`dpm install 3.4.11`) and JAVA_HOME, because the sandbox is the SDK's daemon.

import assert from "node:assert/strict";
import test from "node:test";
import { listDars, resolveArtifacts } from "../../../scripts/canton/artifacts.js";
import { bootstrap, PACKAGES, RECEIVER } from "../../../scripts/canton/bootstrap.js";
import { committeeKey, publicKeyOf } from "../../../scripts/canton/committee.js";
import { deliver } from "../../../scripts/canton/deliver.js";
import { ledger, startSandbox, variant } from "../../../scripts/canton/sandbox.js";

// `canton-localnet` from chain-selectors. The local participant plays this chain.
const CANTON_LOCALNET_SELECTOR = "8706591216959472610";
// Ethereum Sepolia, the lane the global config opens.
const ETHEREUM_SEPOLIA_SELECTOR = "16015286601757825753";
const PAYLOAD = "hello from ethereum";

test(
  "deploys a CCIP instance and delivers a message through the OffRamp",
  { timeout: 300_000 },
  async () => {
    const dars = listDars(resolveArtifacts());
    assert.ok(dars.length >= 40);

    const sandbox = await startSandbox({ dars });
    try {
      const api = ledger(sandbox.url);
      await waitForPackage(api, PACKAGES.factory);

      const alice = await api.allocateParty("alice");
      const committeeKeys = [committeeKey(0)];
      const { addresses, deployed, router } = await bootstrap({
        api,
        owner: alice,
        chainSelector: CANTON_LOCALNET_SELECTOR,
        sourceChainSelector: ETHEREUM_SEPOLIA_SELECTOR,
        committeeSignerKeys: committeeKeys.map(publicKeyOf),
      });
      assert.equal(Object.keys(deployed).length, 9);

      const receiver = await api.create(
        RECEIVER,
        {
          instanceId: "chainlink-local-receiver",
          owner: alice,
          requiredCCVs: [],
          optionalCCVs: [],
          optionalThreshold: 0,
          receiverFinalityConfig: variant("WaitForFinality"),
        },
        alice,
      );

      const result = await deliver({
        api,
        owner: alice,
        receiver,
        router,
        deployed,
        addresses,
        receiverParty: alice,
        sourceChainSelector: ETHEREUM_SEPOLIA_SELECTOR,
        committeeKeys,
        data: Buffer.from(PAYLOAD).toString("hex"),
      });

      assert.match(result.messageId, /^0x[0-9a-f]{64}$/);
      // The receiver returns a CCIPMessageReceived contract the application can read.
      assert.ok(result.messageReceived);
    } finally {
      await sandbox.stop();
    }
  },
);

async function waitForPackage(api, packageId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await api.packages()).includes(packageId)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`package ${packageId} did not load within ${timeoutMs}ms`);
}
