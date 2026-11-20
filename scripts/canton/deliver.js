// Delivers an inbound CCIP message through the real OffRamp on a local Canton participant.
// Mirrors the upstream `OffRampExecute` test: PrepareExecute, add a CCV verification, Execute.

import { EXECUTING_MESSAGE_INTERFACE } from "./bootstrap.js";
import {
  bytesToHex,
  encodeMessageV1,
  finalityConfig,
  hashAddress,
  hexToBytes,
  messageId,
} from "./codec.js";

/**
 * @param {object} opts
 * @param {any} opts.api ledger client
 * @param {string} opts.owner party that owns the router and every CCIP contract
 * @param {string} opts.router per-party router contract id
 * @param {object} opts.deployed contract ids from `bootstrap`
 * @param {object} opts.addresses instance addresses from `bootstrap`
 * @param {string} opts.receiverParty party the message is addressed to
 * @param {string} opts.sourceChainSelector lane selector, as a decimal string
 * @param {string} opts.onRampAddress 32-byte hex
 * @param {string} opts.sender 32-byte hex
 * @param {string} opts.data hex payload
 */
export async function deliver(opts) {
  const {
    api,
    owner,
    router,
    deployed,
    addresses,
    receiverParty,
    sourceChainSelector,
    onRampAddress = `000000000000000000000000${"11".repeat(20)}`,
    sender = `000000000000000000000000${"33".repeat(20)}`,
    data = "",
    sequenceNumber = 1n,
    ccipReceiveGasLimit = 200_000,
    log = () => {},
  } = opts;

  const encoded = encodeMessageV1({
    sourceChainSelector: BigInt(sourceChainSelector),
    destChainSelector: BigInt(addresses.chainSelector),
    sequenceNumber,
    executionGasLimit: 0,
    ccipReceiveGasLimit,
    finality: finalityConfig(0),
    ccvAndExecutorHash: new Uint8Array(32),
    onRampAddress: hexToBytes(onRampAddress),
    // The OffRamp asserts the message names this instance's OffRamp.
    offRampAddress: hashAddress(addresses.offRamp.unpack),
    sender: hexToBytes(sender),
    receiver: hashAddress(receiverParty),
    destBlob: new Uint8Array(),
    messageData: hexToBytes(data),
  });

  const context = {
    values: {
      "global-config": avContractId(deployed.globalConfig),
      "rmn-remote": avContractId(deployed.rmnRemote),
      "token-admin-registry": avContractId(deployed.tokenAdminRegistry),
      "off-ramp": avContractId(deployed.offRamp),
    },
  };

  const prepared = await api.exercise(
    addresses.routerTemplate,
    router,
    "PrepareExecute",
    {
      context,
      encodedMessage: bytesToHex(encoded),
      receiverParty,
      tokenReceiverParty: null,
      receiverRequiredCCVs: [],
      receiverOptionalCCVs: [],
      receiverOptionalThreshold: 0,
      receiverFinalityConfig: { tag: "WaitForFinality", value: {} },
      caller: owner,
    },
    owner,
  );

  const candidates = prepared.filter((e) => e.templateId.includes("ExecutingMessage"));
  // A nested create can appear archived next to the live one; only the active contract can be used.
  const executingMessage = candidates.find((e) => e.acsDelta) ?? candidates[0];
  log(`prepare: ${candidates.length} executing message event(s)`);
  if (!executingMessage) throw new Error("PrepareExecute produced no ExecutingMessage");
  log(`executing message ${executingMessage.contractId.slice(0, 16)}...`);

  // The upstream tests take the same shortcut: add the verification directly instead of
  // running ECDSA, because the receiver field is a hash of a party allocated at runtime.
  // The choice returns a new ExecutingMessage and archives the one passed in.
  const verified = await api.exercise(
    EXECUTING_MESSAGE_INTERFACE,
    executingMessage.contractId,
    "ExecutingMessage_AddCCVVerification",
    {
      ccvInstanceId: addresses.committeeVerifier.unpack.split("@")[0],
      versionTag: "e9a05a20",
      context: { values: {} },
      caller: owner,
    },
    owner,
  );
  const verifiedMessage = verified.find(
    (e) => e.templateId.includes("ExecutingMessage") && e.acsDelta,
  );
  if (!verifiedMessage) throw new Error("AddCCVVerification produced no ExecutingMessage");

  const executed = await api.exercise(
    addresses.routerTemplate,
    router,
    "Execute",
    { context, executingMessageCid: verifiedMessage.contractId },
    owner,
  );

  const finalRouter = executed.find((e) => e.templateId.endsWith(":PerPartyRouter"));
  log(`message id ${messageId(encoded)}`);

  return { messageId: messageId(encoded), encoded, router: finalRouter?.contractId, events: executed };
}

const avContractId = (contractId) => ({ tag: "AV_ContractId", value: contractId });

