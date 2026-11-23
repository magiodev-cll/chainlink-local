// Deploys the CCIP 2.0 contracts onto a local Canton participant through the upstream `CCIPFactory`.
// Each choice consumes the factory and creates a new one next to the deployed contract.

import { instanceAddress, variant } from "./sandbox.js";

// Main package ids of the pinned release (`contracts/v2.3.0`). They move only when the pin moves.
export const PACKAGES = {
  factory: "cd7b0a067409cab6c20213829cfad5388cf7f669d1e2561dc406a44ef058082e",
  runtime: "00ce3527b21ca012761fa58fae105954103a62bc4d72a2018d001b32b79a11a9",
  api: "7fffaf108129d37413d8edfbd91ffe373051b2cb0621c26e245093c6138daf58",
  receiver: "95c3cdc53c172c7202f5b2711ad01d591c84e0aa00cbce4fd0d9ad8f75c11552",
};

export const FACTORY = `${PACKAGES.factory}:CCIP.FactoryV2:CCIPFactory`;
export const ROUTER_FACTORY = `${PACKAGES.runtime}:CCIP.RuntimeV2.PerPartyRouter:PerPartyRouterFactory`;
export const ROUTER_TEMPLATE = `${PACKAGES.runtime}:CCIP.RuntimeV2.PerPartyRouter:PerPartyRouter`;
export const EXECUTING_MESSAGE_INTERFACE = `${PACKAGES.api}:CCIP.APIV2.ExecutingMessage:IExecutingMessage`;
export const RECEIVER = `${PACKAGES.receiver}:CCIP.CCIPReceiver:CCIPReceiver`;

/** A local instance id. Every CCIP contract in the instance is addressed as `<instanceId>@<party>`. */
export const INSTANCE_ID = "chainlink-local";

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

  return { factory, router: router.contractId, addresses: at, deployed };
}
