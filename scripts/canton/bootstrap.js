// Deploys the CCIP 2.0 contracts onto a local Canton participant through the upstream `CCIPFactory`.
// Each choice consumes the factory and creates a new one next to the deployed contract.

import { instanceAddress, variant } from "./sandbox.js";

// Main package ids of the pinned release (`contracts/v2.3.0`). They move only when the pin moves.
export const PACKAGES = {
  factory: "cd7b0a067409cab6c20213829cfad5388cf7f669d1e2561dc406a44ef058082e",
  runtime: "00ce3527b21ca012761fa58fae105954103a62bc4d72a2018d001b32b79a11a9",
  api: "7fffaf108129d37413d8edfbd91ffe373051b2cb0621c26e245093c6138daf58",
  receiver: "95c3cdc53c172c7202f5b2711ad01d591c84e0aa00cbce4fd0d9ad8f75c11552",
  committeeVerifier: "0ad9d7694de68cd774fe399999722cf5fd8c514066125261e21b42431cfc962e",
  core: "7a08ead9e5158d6e493c144c63a91b1a7e23b9424359c1551ccfad991ba39c39",
  burnMintPool: "a4a07fc1d1d686f778821a78c795c8df6dc3896dd3f171d991bfa5f374f86662",
  rateLimiter: "3c33043d19b1a5eb1b842d3c1634ab73c6886c3b1e0b36628053093dbe5739c3",
};

export const FACTORY = `${PACKAGES.factory}:CCIP.FactoryV2:CCIPFactory`;
export const ROUTER_FACTORY = `${PACKAGES.runtime}:CCIP.RuntimeV2.PerPartyRouter:PerPartyRouterFactory`;
export const ROUTER_TEMPLATE = `${PACKAGES.runtime}:CCIP.RuntimeV2.PerPartyRouter:PerPartyRouter`;
export const EXECUTING_MESSAGE_INTERFACE = `${PACKAGES.api}:CCIP.APIV2.ExecutingMessage:IExecutingMessage`;
export const RECEIVER = `${PACKAGES.receiver}:CCIP.CCIPReceiver:CCIPReceiver`;
export const COMMITTEE_VERIFIER = `${PACKAGES.committeeVerifier}:CCIP.CommitteeVerifierV2:CommitteeVerifier`;
export const TOKEN_ADMIN_REGISTRY = `${PACKAGES.core}:CCIP.CoreV2.TokenAdminRegistry:TokenAdminRegistry`;
export const TOKEN_CONFIG = "TokenConfig";

/** A local instance id. Every CCIP contract in the instance is addressed as `<instanceId>@<party>`. */
export const INSTANCE_ID = "chainlink-local";

/** The LINK stand-in deployed by the factory, used as fee token and by the pools. */
export const LINK_INSTANCE_ID = `${INSTANCE_ID}-link`;
export const LINK_INSTRUMENT_ID = (owner) => ({ admin: owner, id: "LINK" });
export const POOL_INSTANCE_ID = `${LINK_INSTANCE_ID}-bm-pool`;
export const POOL_TEMPLATE = `${PACKAGES.burnMintPool}:CCIP.BurnMintTokenPoolV2:BurnMintTokenPool`;
export const RATE_LIMITER_TEMPLATE = `${PACKAGES.rateLimiter}:CCIP.RateLimiterV2:RateLimiter`;

/**
 * Deploys global config, RMN remote, token admin registry, fee quoter, committee verifier,
 * executor, offRamp, onRamp and the router factory. Returns the deployed contract ids.
 */
export async function bootstrap({
  api,
  owner,
  chainSelector,
  sourceChainSelector,
  sourceOnRamp = `000000000000000000000000${"11".repeat(20)}`,
  versionTag = "e9a05a20",
  committeeSignerKeys = [],
  committeeThreshold = 1,
  log = () => {},
}) {
  const at = {
    globalConfig: instanceAddress(INSTANCE_ID, owner),
    rmnRemote: instanceAddress(`${INSTANCE_ID}-rmn`, owner),
    tokenAdminRegistry: instanceAddress(`${INSTANCE_ID}-token-registry`, owner),
    feeQuoter: instanceAddress(`${INSTANCE_ID}-fee-quoter`, owner),
    offRamp: instanceAddress(`${INSTANCE_ID}-offramp`, owner),
    onRamp: instanceAddress(`${INSTANCE_ID}-onramp`, owner),
    routerFactory: instanceAddress(`${INSTANCE_ID}-router-factory`, owner),
    committeeVerifier: instanceAddress(`${INSTANCE_ID}-committee-verifier`, owner),
    executor: instanceAddress(`${INSTANCE_ID}-executor`, owner),
  };

  let factory = await api.create(
    FACTORY,
    {
      instanceId: INSTANCE_ID,
      owner,
      mcmsParty: owner,
      usedInstanceIds: [],
      deployedContracts: [],
      perPartyRouterFactoryDeployed: false,
    },
    owner,
  );
  log(`factory ${factory.slice(0, 16)}...`);

  // Each deploy archives the current factory and creates a new one, so the id is threaded forward.
  const deploy = async (choice, contract) => {
    const events = await api.exercise(FACTORY, factory, choice, { contract }, owner);
    const next = events.find((e) => e.templateId.includes("CCIPFactory"));
    const deployed = events.find((e) => !e.templateId.includes("CCIPFactory"));
    if (!next || !deployed) throw new Error(`${choice} returned ${events.length} created events`);
    factory = next.contractId;
    log(`${choice}: ok`);
    return deployed.contractId;
  };

  const deployed = {};

  // A source lane must exist before the OffRamp will accept a message from it. The committee
  // verifier is lane-mandated, so every inbound message has to carry its verification.
  const sourceChainConfigs = sourceChainSelector
    ? [
        [
          sourceChainSelector,
          {
            isEnabled: true,
            onRampAddresses: [sourceOnRamp],
            laneMandatedCCVs: [at.committeeVerifier],
            defaultCCVs: [],
          },
        ],
      ]
    : [];

  deployed.globalConfig = await deploy("DeployGlobalConfig", {
    instanceId: INSTANCE_ID,
    ccipOwner: owner,
    chainSelector,
    destChainConfigs: [],
    sourceChainConfigs,
  });

  deployed.rmnRemote = await deploy("DeployRMNRemote", {
    instanceId: `${INSTANCE_ID}-rmn`,
    rmnOwner: owner,
    ccipOwner: owner,
    customObservers: [],
    cursedSubjects: [],
  });

  deployed.tokenAdminRegistry = await deploy("DeployTokenAdminRegistry", {
    instanceId: `${INSTANCE_ID}-token-registry`,
    ccipOwner: owner,
    entryCount: 0,
  });

  deployed.feeQuoter = await deploy("DeployFeeQuoter", {
    instanceId: `${INSTANCE_ID}-fee-quoter`,
    ccipOwner: owner,
    feeTokens: { map: [] },
    destChainConfigs: [],
    tokenTransferFeeConfigs: [],
    usdPerUnitGasByDestChainSelector: [],
    usdPerToken: [],
    linkTokenInstrumentId: { admin: owner, id: "LINK" },
    priceUpdaters: [],
  });

  deployed.committeeVerifier = await deploy("DeployCommitteeVerifier", {
    instanceId: `${INSTANCE_ID}-committee-verifier`,
    owner,
    ccipOwner: owner,
    versionTag,
    allowListAdmin: null,
    messageSentObservers: [],
    storageLocations: [],
    storageLocationsAdmin: owner,
    pendingStorageLocationsAdmin: owner,
    remoteChainConfigs: [],
    signerConfigs: [],
    deps: { rmnRemote: at.rmnRemote },
  });

  deployed.executor = await deploy("DeployExecutor", {
    instanceId: `${INSTANCE_ID}-executor`,
    owner,
    maxCCVsPerMsg: 10,
    dynamicConfig: {
      feeAggregator: null,
      allowedFinalityConfig: variant("WaitForSafe"),
      ccvAllowlistEnabled: false,
    },
    allowedCCVs: [],
    remoteChainConfigs: [],
  });

  // The verifier only accepts messages from chains it has a signature config for.
  if (sourceChainSelector && committeeSignerKeys.length > 0) {
    deployed.committeeVerifier = await configureVerifier({
      api,
      owner,
      verifier: deployed.committeeVerifier,
      sourceChainSelector,
      signerKeys: committeeSignerKeys,
      threshold: committeeThreshold,
      log,
    });
  }

  // The LINK stand-in is a full Splice instrument: holdings, transfer factory and burn/mint.
  // It is the fee token for sends and the token the pools move.
  deployed.linkRegistry = await deploy("DeployLinkToken", {
    instanceId: LINK_INSTANCE_ID,
    registryAdmin: owner,
    registryInstrumentId: LINK_INSTRUMENT_ID(owner),
    registryMeta: { values: {} },
  });

  // A burn/mint pool for the LINK instrument, then the registry handshake that makes it official.
  deployed.tokenPool = await deploy("DeployBurnMintTokenPool", {
    instanceId: POOL_INSTANCE_ID,
    poolOwner: owner,
    ccipOwner: owner,
    instrumentId: LINK_INSTRUMENT_ID(owner),
    decimals: 10,
    rateLimitAdmin: null,
    remoteChainConfigs: [],
    tokenTransferFeeConfigs: [],
    poolReceiveContext: { values: {} },
    transferTimeout: variant("Indefinite"),
    deps: {
      tokenAdminRegistry: at.tokenAdminRegistry,
      feeQuoter: at.feeQuoter,
      rmnRemote: at.rmnRemote,
    },
  });

  const registered = await registerPool({
    api,
    owner,
    registry: deployed.tokenAdminRegistry,
    instrumentId: LINK_INSTRUMENT_ID(owner),
    log,
  });
  deployed.tokenAdminRegistry = registered.registry;
  deployed.tokenConfig = registered.tokenConfig;

  // The pool needs a remote chain entry before it will accept a transfer from that chain.
  if (sourceChainSelector) {
    // The pool rejects identical limiter addresses, so inbound, inbound-custom and outbound are separate.
    const limiter = async (suffix, direction, mode) => {
      const instanceId = `${POOL_INSTANCE_ID}-${suffix}`;
      const cid = await deploy("DeployRateLimiter", {
        instanceId,
        poolInstanceId: POOL_INSTANCE_ID,
        poolOwner: owner,
        remoteChainSelector: sourceChainSelector,
        // All-nullary enums are plain strings; only constructors with arguments use {tag, value}.
        direction,
        mode,
        isEnabled: true,
        capacity: "1000000000",
        rate: "1000000000",
        tokens: "1000000000",
        lastUpdated: new Date().toISOString(),
      });
      return { cid, address: instanceAddress(instanceId, owner) };
    };

    const inboundLimiter = await limiter("inbound-limiter", "RateLimitDirection_Inbound", "RateLimitMode_DefaultFinality");
    const inboundCustomLimiter = await limiter("inbound-custom-limiter", "RateLimitDirection_Inbound", "RateLimitMode_CustomFinality");
    const outboundLimiter = await limiter("outbound-limiter", "RateLimitDirection_Outbound", "RateLimitMode_DefaultFinality");
    deployed.inboundRateLimiter = inboundLimiter.cid;

    const added = await api.exercise(POOL_TEMPLATE, deployed.tokenPool, "ApplyChainUpdates", {
      remoteChainSelectorsToRemove: [],
      chainsToAdd: [
        {
          remoteChainSelector: sourceChainSelector,
          remotePools: ["66".repeat(32)],
          remoteTokenAddress: "55".repeat(32),
          inboundCCVs: [at.committeeVerifier],
          outboundCCVs: [],
          finalityConfig: variant("WaitForFinality"),
          inboundRateLimiter: inboundLimiter.address,
          inboundCustomBlockConfirmationsRateLimiter: inboundCustomLimiter.address,
          outboundRateLimiter: outboundLimiter.address,
        },
      ],
    }, owner);
    const next = added.find((e) => e.templateId.endsWith(":BurnMintTokenPool") && e.acsDelta);
    if (!next) throw new Error("ApplyChainUpdates produced no pool");
    deployed.tokenPool = next.contractId;
    log("pool opened for the source lane");
  }

  deployed.offRamp = await deploy("DeployOffRamp", {
    instanceId: `${INSTANCE_ID}-offramp`,
    ccipOwner: owner,
    deps: {
      globalConfig: at.globalConfig,
      rmnRemote: at.rmnRemote,
      tokenAdminRegistry: at.tokenAdminRegistry,
    },
  });

  deployed.onRamp = await deploy("DeployOnRamp", {
    instanceId: `${INSTANCE_ID}-onramp`,
    ccipOwner: owner,
    maxUSDCentsPerMsg: "1000000",
    deps: {
      globalConfig: at.globalConfig,
      rmnRemote: at.rmnRemote,
      tokenAdminRegistry: at.tokenAdminRegistry,
      feeQuoter: at.feeQuoter,
    },
  });

  deployed.routerFactory = await deploy("DeployPerPartyRouterFactory", {
    instanceId: `${INSTANCE_ID}-router-factory`,
    ccipOwner: owner,
    deps: {
      onRamp: at.onRamp,
      offRamp: at.offRamp,
      globalConfig: at.globalConfig,
      tokenAdminRegistry: at.tokenAdminRegistry,
      feeQuoter: at.feeQuoter,
      rmnRemote: at.rmnRemote,
    },
    registeredRouters: [],
  });

  const routerEvents = await api.exercise(
    ROUTER_FACTORY,
    deployed.routerFactory,
    "CreateRouter",
    { partyOwner: owner, instanceId: "router", feeTransferLifetime: null },
    owner,
  );
  const router = routerEvents.find(
    (e) => e.templateId.endsWith(":PerPartyRouter") && !e.templateId.includes("Factory"),
  );
  if (!router) throw new Error("CreateRouter produced no PerPartyRouter");
  log("CreateRouter: ok");

  at.chainSelector = chainSelector;
  at.routerTemplate = ROUTER_TEMPLATE;
  at.receiverTemplate = RECEIVER;

  return { factory, router: router.contractId, addresses: at, deployed };
}

async function configureVerifier({ api, owner, verifier, sourceChainSelector, signerKeys, threshold, log }) {
  const replaced = (events) => {
    const next = events.find((e) => e.templateId.endsWith(":CommitteeVerifier"));
    if (!next) throw new Error("verifier choice produced no CommitteeVerifier");
    return next.contractId;
  };

  const afterChain = replaced(
    await api.exercise(COMMITTEE_VERIFIER, verifier, "ApplyRemoteChainConfigUpdates", {
      remoteChainConfigArgs: [
        {
          remoteChainSelector: sourceChainSelector,
          feeUSDCents: "0",
          gasForVerification: 100_000,
          payloadSizeBytes: 10_000,
          allowListEnabled: false,
        },
      ],
    }, owner),
  );

  const afterSigners = replaced(
    await api.exercise(COMMITTEE_VERIFIER, afterChain, "ApplySignatureConfigs", {
      sourceChainSelectorsToRemove: [],
      signatureConfigs: [{ sourceChainSelector, threshold, signerKeys }],
    }, owner),
  );

  log(`verifier configured: ${signerKeys.length} signer(s), threshold ${threshold}`);
  return afterSigners;
}

/** Propose, accept and set the pool. One party owns everything locally, so no disclosure is needed. */
async function registerPool({ api, owner, registry, instrumentId, log }) {
  const newest = (events) => {
    const config = events.find((e) => e.templateId.endsWith(":TokenConfig") && e.acsDelta);
    if (!config) throw new Error("registry choice produced no TokenConfig");
    return config.contractId;
  };

  const proposed = await api.exercise(TOKEN_ADMIN_REGISTRY, registry, "ProposeAdministrator", {
    tokenConfigCid: null,
    instrumentId,
    newAdmin: owner,
    context: { values: {} },
    caller: owner,
  }, owner);

  const accepted = await api.exercise(TOKEN_ADMIN_REGISTRY, registry, "AcceptAdminRole", {
    tokenConfigCid: newest(proposed),
    instrumentId,
    context: { values: {} },
    caller: owner,
  }, owner);

  const config = newest(
    await api.exercise(TOKEN_ADMIN_REGISTRY, registry, "SetPool", {
      tokenConfigCid: newest(accepted),
      instrumentId,
      tokenPool: { poolOwner: owner, poolInstanceId: POOL_INSTANCE_ID },
      context: { values: {} },
      caller: owner,
    }, owner),
  );

  log("token pool registered for LINK");
  return { registry, tokenConfig: config };
}
