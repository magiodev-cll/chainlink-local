// EXPERIMENTAL: run `deliver` and `send` as a party that does not own the CCIP contracts.
//
// Locally one party owns everything, so every contract is visible and no disclosures are needed.
// On a real network the app party sees only its own router and receiver, so every context contract
// must be passed as a disclosed contract. Only a party that can see those contracts can export them.
// This module does not fetch them from a network service; the caller supplies the bundle.

import { ROUTER_FACTORY } from "./bootstrap.js";
import { deliver } from "./deliver.js";
import { toAny2EvmMessage } from "./evm.js";
import { ledger } from "./sandbox.js";
import { send } from "./send.js";

/**
 * Builds the bundle another party needs. Call it as a party that can see the CCIP contracts,
 * normally the deployer. Every `deployed` entry is disclosed; the router and receiver belong to
 * the app party and need no disclosure.
 */
export async function exportInstance({ api, party, deployed, addresses, router, receiver }) {
  const visible = await api.activeContractsWildcard(party);
  const byId = new Map(visible.map((created) => [created.contractId, created]));
  const synchronizerId = await api.synchronizerId();

  // Only what `deliver` and `send` read from the context; the factory and executor are not used.
  const needed = [
    "globalConfig", "rmnRemote", "tokenAdminRegistry", "feeQuoter", "offRamp", "onRamp",
    "committeeVerifier", "linkRegistry", "tokenPool", "tokenConfig",
    "inboundRateLimiter", "outboundRateLimiter",
  ];

  const disclosures = [];
  for (const name of needed) {
    const contractId = deployed[name];
    if (!contractId) continue;
    const created = byId.get(contractId);
    if (!created) throw new Error(`cannot disclose ${name} ${contractId}: not visible to ${party}`);
    disclosures.push({
      templateId: created.templateId,
      contractId,
      createdEventBlob: created.createdEventBlob,
      synchronizerId,
    });
  }

  // The app party creates its own router, and it cannot see the factory, so ship its disclosure too.
  const factory = byId.get(deployed.routerFactory);
  const factoryDisclosure = factory
    ? {
        templateId: factory.templateId,
        contractId: factory.contractId,
        createdEventBlob: factory.createdEventBlob,
        synchronizerId,
      }
    : undefined;

  return { deployed, addresses, router, receiver, disclosures, factoryDisclosure, synchronizerId };
}

/**
 * Connects to a running participant as `party`, using a bundle from `exportInstance`.
 * `deliver` needs the committee keys or explicit verifierResults, because a real lane's
 * committee signatures cannot be produced locally.
 */
export async function connectCanton({ url, party, bundle, log = () => {} }) {
  const api = ledger(url);
  let router = bundle.router;

  const requireRouter = () => {
    if (!router) throw new Error("no router for this party yet: call createRouter() first");
    return router;
  };

  /** Testnet has no local bootstrap: the app creates its own router from the deployed factory. */
  async function createRouter({ instanceId = "app-router" } = {}) {
    if (!bundle.factoryDisclosure) {
      throw new Error("bundle has no router factory disclosure; export it as a party that can see the factory");
    }
    const events = await api.exercise(
      ROUTER_FACTORY,
      bundle.deployed.routerFactory,
      "CreateRouter",
      { partyOwner: party, instanceId, feeTransferLifetime: null },
      party,
      { disclosedContracts: [bundle.factoryDisclosure] },
    );

    const created = events.find((e) => e.templateId.endsWith(":PerPartyRouter") && e.acsDelta);
    if (!created) throw new Error("CreateRouter produced no PerPartyRouter");
    router = created.contractId;

    // The factory is consumed too; keep the id current for a second create.
    const nextFactory = events.find(
      (e) => e.templateId.endsWith(":PerPartyRouterFactory") && e.acsDelta,
    );
    if (nextFactory) {
      bundle.deployed.routerFactory = nextFactory.contractId;
      const wildcard = await api.activeContractsWildcard(party).catch(() => []);
      const factory = wildcard.find((c) => c.contractId === nextFactory.contractId);
      if (factory) {
        bundle.factoryDisclosure = {
          templateId: factory.templateId,
          contractId: factory.contractId,
          createdEventBlob: factory.createdEventBlob,
          synchronizerId: await api.synchronizerId(),
        };
      }
    }

    log(`router created for ${party}`);
    return router;
  }

  const base = () => ({
    api,
    owner: party,
    party,
    receiver: bundle.receiver,
    deployed: bundle.deployed,
    addresses: bundle.addresses,
    receiverParty: party,
    disclosures: bundle.disclosures,
    log,
  });

  return {
    api,
    party,
    receiver: bundle.receiver,
    deployed: bundle.deployed,
    addresses: bundle.addresses,
    disclosures: bundle.disclosures,
    get router() {
      return router;
    },

    createRouter,

    async deliver(opts = {}) {
      const result = await deliver({ ...base(), router: requireRouter(), ...opts });
      router = result.router;
      return result;
    },

    async send(opts = {}) {
      const result = await send({ ...base(), router: requireRouter(), ...opts });
      router = result.router;
      return result;
    },

    async routeToCanton(opts = {}) {
      const sent = await this.send(opts);
      return {
        ...sent,
        evmMessage: toAny2EvmMessage({
          messageId: `0x${sent.messageId}`,
          sourceChainSelector: bundle.addresses.chainSelector,
          sender: opts.evmSender ?? `0x${"00".repeat(20)}`,
          data: opts.payload ?? "",
        }),
      };
    },

    async stop() {},
  };
}
