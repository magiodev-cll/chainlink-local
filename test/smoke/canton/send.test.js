// Local mode, outbound: configure the destination lane and send a message from Canton.
// Needs the Daml SDK (`dpm install 3.4.11`) and JAVA_HOME, like the delivery test.

import assert from "node:assert/strict";
import test from "node:test";
import { listDars, resolveArtifacts } from "../../../scripts/canton/artifacts.js";
import { bootstrap, PACKAGES } from "../../../scripts/canton/bootstrap.js";
import { committeeKey, publicKeyOf } from "../../../scripts/canton/committee.js";
import { configureDestLane } from "../../../scripts/canton/lane.js";
import { send } from "../../../scripts/canton/send.js";
import { ledger, startSandbox } from "../../../scripts/canton/sandbox.js";

const CANTON_LOCALNET_SELECTOR = "8706591216959472610";
const ETHEREUM_SEPOLIA_SELECTOR = "16015286601757825753";

test("configures the outbound lane and sends a message", { timeout: 300_000 }, async () => {
  const sandbox = await startSandbox({ dars: listDars(resolveArtifacts()) });
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

    const lane = await configureDestLane({
      api,
      owner: alice,
      deployed,
      destChainSelector: ETHEREUM_SEPOLIA_SELECTOR,
      committeeVerifier: addresses.committeeVerifier,
    });
    assert.ok(lane.globalConfig);
    assert.ok(lane.feeQuoter);

    const sent = await send({
      api,
      owner: alice,
      router,
      deployed,
      addresses,
      destChainSelector: ETHEREUM_SEPOLIA_SELECTOR,
      receiver: `${"00".repeat(12)}${"44".repeat(20)}`,
      payload: Buffer.from("hello evm").toString("hex"),
    });
    assert.ok(sent.router);
    assert.notEqual(sent.router, router);
  } finally {
    await sandbox.stop();
  }
});

async function waitForPackage(api, packageId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await api.packages()).includes(packageId)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`package ${packageId} did not load within ${timeoutMs}ms`);
}
