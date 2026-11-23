// Delivers an inbound CCIP message the way an application does: one call to the receiver,
// which prepares, verifies the CCV signatures, runs the pools and executes.
// Mirrors `CCIP.CCIPReceiver.Execute`.

import { verifierResults } from "./committee.js";
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
 * @param {string} opts.owner party that owns the router, the receiver and the CCIP contracts
 * @param {string} opts.receiver CCIPReceiver contract id
 * @param {string} opts.router per-party router contract id
 * @param {object} opts.deployed contract ids from `bootstrap`
 * @param {object} opts.addresses instance addresses from `bootstrap`
 * @param {string} opts.receiverParty party the message is addressed to
 * @param {string} opts.sourceChainSelector lane selector, as a decimal string
 * @param {Uint8Array[]} opts.committeeKeys private keys the verifier is configured with
 */
export async function deliver(opts) {
  const {
    api,
    owner,
    receiver,
    router,
    deployed,
    addresses,
    receiverParty,
    sourceChainSelector,
    committeeKeys = [],
    versionTag = "e9a05a20",
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

  const id = messageId(encoded);
  const context = {
    values: {
      "global-config": avContractId(deployed.globalConfig),
      "rmn-remote": avContractId(deployed.rmnRemote),
      "token-admin-registry": avContractId(deployed.tokenAdminRegistry),
      "off-ramp": avContractId(deployed.offRamp),
    },
  };

  const events = await api.exercise(
    addresses.receiverTemplate,
    receiver,
    "Execute",
    {
      routerCid: router,
      encodedMessage: bytesToHex(encoded),
      tokenTransfer: null,
      ccvInputs: [
        {
          ccvCid: deployed.committeeVerifier,
          verifierResults: verifierResults(id, committeeKeys, versionTag),
          context: { values: {} },
        },
      ],
      context,
    },
    owner,
  );

  const received = events.find((e) => e.templateId.endsWith(":CCIPMessageReceived"));
  if (!received) throw new Error("receiver Execute produced no CCIPMessageReceived");
  log(`message received ${received.contractId.slice(0, 16)}...`);

  return { messageId: id, encoded, messageReceived: received.contractId, events };
}

const avContractId = (contractId) => ({ tag: "AV_ContractId", value: contractId });
