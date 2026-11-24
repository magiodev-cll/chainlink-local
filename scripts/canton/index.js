// Public entry point for the Canton adapter. `startCantonLocal()` follows the same shape as the SVM
// adapter: one call gives you a chain with the real CCIP contracts, plus `deliver` and `send`.

import { listDars, resolveArtifacts } from "./artifacts.js";
import { bootstrap, PACKAGES, RECEIVER } from "./bootstrap.js";
import { committeeKey, publicKeyOf } from "./committee.js";
import { deliver } from "./deliver.js";
import { configureDestLane } from "./lane.js";
import { ledger, startSandbox, variant } from "./sandbox.js";
import { send } from "./send.js";
import { toAny2EvmMessage } from "./evm.js";

export { ARTIFACTS, listDars, resolveArtifacts } from "./artifacts.js";
export { bootstrap, INSTANCE_ID, LINK_INSTRUMENT_ID, PACKAGES, RECEIVER } from "./bootstrap.js";
export { encodeMessageV1, encodeTokenTransferV1, finalityConfig, hashAddress, messageId } from "./codec.js";
export { committeeKey, publicKeyOf, verifierResults } from "./committee.js";
export { deliver } from "./deliver.js";
export { toAny2EvmMessage } from "./evm.js";
export { configureDestLane } from "./lane.js";
export { connectCanton, exportInstance } from "./connect.js";
export { instanceAddress, ledger, startSandbox, variant } from "./sandbox.js";
export { send } from "./send.js";

/** Canton LocalNet, per chain-selectors. The local participant plays this chain. */
export const CANTON_LOCALNET_SELECTOR = "8706591216959472610";
/** Ethereum Sepolia, the lane the adapter opens by default in both directions. */
export const ETHEREUM_SEPOLIA_SELECTOR = "16015286601757825753";

/**
 * Starts a participant, deploys a CCIP instance and creates a receiver for the local party.
 * The returned `deliver` and `send` keep the router id current, because `Execute` and `CCIPSend`
 * both consume it.
 *
 * @param {object} [opts]
 * @param {Uint8Array[]} [opts.committeeKeys] defaults to the deterministic seed-0 key
 * @param {object} [opts.sandbox] an already running sandbox, e.g. to share one across a suite
 */
export async function startCantonLocal({
  chainSelector = CANTON_LOCALNET_SELECTOR,
  sourceChainSelector = ETHEREUM_SEPOLIA_SELECTOR,
  destChainSelector = ETHEREUM_SEPOLIA_SELECTOR,
  committeeKeys = [committeeKey(0)],
  log = () => {},
  sandbox,
} = {}) {
  const ownsSandbox = !sandbox;
  const box = sandbox ?? (await startSandbox({ dars: listDars(resolveArtifacts()), log }));
  const api = ledger(box.url);

  await waitForPackage(api, PACKAGES.factory);
  const party = await api.allocateParty("chainlink-local");

  const instance = await bootstrap({
    api,
    owner: party,
    chainSelector,
    sourceChainSelector,
    committeeSignerKeys: committeeKeys.map(publicKeyOf),
    log,
  });

  const receiver = await api.create(
    RECEIVER,
    {
      instanceId: "chainlink-local-receiver",
      owner: party,
      requiredCCVs: [],
      optionalCCVs: [],
      optionalThreshold: 0,
      receiverFinalityConfig: variant("WaitForFinality"),
    },
    party,
  );

  let router = instance.router;
  let laneReady = false;

  return {
    api,
    party,
    receiver,
    committeeKeys,
    addresses: instance.addresses,
    deployed: instance.deployed,
    get router() {
      return router;
    },

    async deliver(opts = {}) {
      const result = await deliver({
        api,
        owner: party,
        receiver,
        router,
        deployed: instance.deployed,
        addresses: instance.addresses,
        receiverParty: party,
        sourceChainSelector,
        committeeKeys,
        log,
        ...opts,
      });
      router = result.router;
      return result;
    },

    async send(opts = {}) {
      if (!laneReady) {
        await configureDestLane({
          api,
          owner: party,
          deployed: instance.deployed,
          destChainSelector,
          committeeVerifier: instance.addresses.committeeVerifier,
          log,
        });
        laneReady = true;
      }
      const result = await send({
        api,
        owner: party,
        router,
        deployed: instance.deployed,
        addresses: instance.addresses,
        destChainSelector,
        log,
        ...opts,
      });
      router = result.router;
      return result;
    },

    /** Send, then hand back the EVM struct `CCIPLocalRouter.routeMessage` takes. */
    async routeToCanton({ evmSender = `0x${"00".repeat(20)}`, ...opts } = {}) {
      const sent = await this.send(opts);
      return {
        ...sent,
        evmMessage: toAny2EvmMessage({
          messageId: `0x${sent.messageId}`,
          sourceChainSelector: chainSelector,
          sender: evmSender,
          data: opts.payload ?? "",
        }),
      };
    },

    async stop() {
      if (ownsSandbox) await box.stop();
    },
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
