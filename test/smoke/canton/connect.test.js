// EXPERIMENTAL: a party that does not own the CCIP contracts creates its own router and delivers,
// using disclosed contracts. This mirrors a testnet app party, where nobody bootstraps for you.

import assert from "node:assert/strict";
import test from "node:test";
import { listDars, resolveArtifacts } from "../../../scripts/canton/artifacts.js";
import { bootstrap, PACKAGES, RECEIVER } from "../../../scripts/canton/bootstrap.js";
import { committeeKey, publicKeyOf } from "../../../scripts/canton/committee.js";
import { connectCanton, exportInstance } from "../../../scripts/canton/connect.js";
import { ledger, startSandbox, variant } from "../../../scripts/canton/sandbox.js";

test("an app party creates a router and delivers with disclosed contracts", { timeout: 300_000 }, async () => {
  const box = await startSandbox({ dars: listDars(resolveArtifacts()) });
  try {
    const api = ledger(box.url);
    await waitForPackage(api, PACKAGES.factory);

    const owner = await api.allocateParty("canton-owner");
    const app = await api.allocateParty("canton-app");

    const committeeKeys = [committeeKey(0)];
    const instance = await bootstrap({
      api,
      owner,
      chainSelector: "8706591216959472610",
      sourceChainSelector: "16015286601757825753",
      committeeSignerKeys: committeeKeys.map(publicKeyOf),
    });

    // The app owns its receiver already; the router is created after connecting.
    const receiver = await api.create(
      RECEIVER,
      {
        instanceId: "canton-app-receiver",
        owner: app,
        requiredCCVs: [],
        optionalCCVs: [],
        optionalThreshold: 0,
        receiverFinalityConfig: variant("WaitForFinality"),
      },
      app,
    );

    const bundle = await exportInstance({
      api,
      party: owner,
      deployed: instance.deployed,
      addresses: instance.addresses,
      receiver,
    });
    assert.ok(bundle.disclosures.length >= 10, "expected disclosures for the context contracts");
    assert.ok(bundle.factoryDisclosure, "expected a router factory disclosure");
    assert.equal(bundle.router, undefined, "no router exists for the app party yet");

    const connected = await connectCanton({ url: box.url, party: app, bundle });

    await assert.rejects(
      () => connected.deliver({ committeeKeys, data: "00" }),
      /call createRouter\(\) first/,
    );

    const router = await connected.createRouter({ instanceId: "app-router" });
    assert.ok(router);
    assert.equal(connected.router, router);

    const result = await connected.deliver({
      sourceChainSelector: "16015286601757825753",
      committeeKeys,
      data: Buffer.from("hello from another party").toString("hex"),
    });

    assert.match(result.messageId, /^0x[0-9a-f]{64}$/);
    assert.ok(result.messageReceived);
  } finally {
    await box.stop();
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
