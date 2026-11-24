// EXPERIMENTAL: a party that does not own the CCIP contracts delivers and sends using disclosed contracts.
// This is the shape a real network needs; here both parties live on one sandbox.

import assert from "node:assert/strict";
import test from "node:test";
import { listDars, resolveArtifacts } from "../../../scripts/canton/artifacts.js";
import {
  bootstrap,
  PACKAGES,
  RECEIVER,
  ROUTER_FACTORY,
} from "../../../scripts/canton/bootstrap.js";
import { committeeKey, publicKeyOf } from "../../../scripts/canton/committee.js";
import { connectCanton, exportInstance } from "../../../scripts/canton/connect.js";
import { ledger, startSandbox, variant } from "../../../scripts/canton/sandbox.js";

test("an app party delivers with disclosed contracts", { timeout: 300_000 }, async () => {
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

    // The app party needs the router factory disclosed to create its own router.
    const factoryDisclosure = await discloseOne(api, owner, instance.deployed.routerFactory);
    const created = await api.exercise(
      ROUTER_FACTORY,
      instance.deployed.routerFactory,
      "CreateRouter",
      { partyOwner: app, instanceId: "app-router", feeTransferLifetime: null },
      app,
      { disclosedContracts: [factoryDisclosure] },
    );
    const router = created.find((e) => e.templateId.endsWith(":PerPartyRouter") && e.acsDelta);
    assert.ok(router, "no router for the app party");

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

    // The deployer exports what the app party cannot see.
    const bundle = await exportInstance({
      api,
      party: owner,
      deployed: instance.deployed,
      addresses: instance.addresses,
      router: router.contractId,
      receiver,
    });
    assert.ok(bundle.disclosures.length >= 10, "expected disclosures for the context contracts");
    assert.ok(bundle.disclosures.every((d) => d.createdEventBlob && d.synchronizerId));

    const connected = await connectCanton({ url: box.url, party: app, bundle });
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

async function discloseOne(api, party, contractId) {
  const visible = await api.activeContractsWildcard(party);
  const created = visible.find((c) => c.contractId === contractId);
  if (!created) {
    const candidates = visible.filter((c) => c.templateId.includes("PerPartyRouter")).map((c) => c.contractId);
    throw new Error(`${contractId} not visible to ${party}; candidates ${candidates.join(",")}`);
  }
  return {
    templateId: created.templateId,
    contractId: created.contractId,
    createdEventBlob: created.createdEventBlob,
    synchronizerId: await api.synchronizerId(),
  };
}

async function waitForPackage(api, packageId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await api.packages()).includes(packageId)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`package ${packageId} did not load within ${timeoutMs}ms`);
}
