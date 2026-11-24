// Delivers an inbound CCIP message the way an application does: one call to the receiver,
// which prepares, verifies the CCV signatures, runs the pools and executes.
// Mirrors `CCIP.CCIPReceiver.Execute`.

import { committeeKey, verifierResults } from "./committee.js";
import {
  bytesToHex,
  encodeMessageV1,
  encodeTokenTransferV1,
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
    committeeKeys = [committeeKey(0)],
    versionTag = "e9a05a20",
    onRampAddress = `000000000000000000000000${"11".repeat(20)}`,
    sender = `000000000000000000000000${"33".repeat(20)}`,
    data = "",
    token,
    sequenceNumber = 1n,
    ccipReceiveGasLimit = 200_000,
    log = () => {},
  } = opts;

  const tokenTransfer = token
    ? encodeTokenTransferV1({
        // CCIP amounts are base units; the Daml side uses whole tokens with 10 decimals.
        amount: word32(token.amount),
        sourcePoolAddress: token.sourcePoolAddress ?? hexToBytes("66".repeat(32)),
        sourceTokenAddress: token.sourceTokenAddress ?? hexToBytes("55".repeat(32)),
        // The pool matches this against keccak256(utf8("<id>@<admin>")) of its instrument.
        destTokenAddress: token.destTokenAddress ?? hashAddress(`LINK@${owner}`),
        tokenReceiver: hashAddress(token.tokenReceiverParty ?? receiverParty),
        extraData: new Uint8Array(),
      })
    : undefined;

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
    tokenTransfer,
    messageData: hexToBytes(data),
  });

  const id = messageId(encoded);
  const context = {
    values: {
      "global-config": avContractId(deployed.globalConfig),
      "rmn-remote": avContractId(deployed.rmnRemote),
      "token-admin-registry": avContractId(deployed.tokenAdminRegistry),
      "off-ramp": avContractId(deployed.offRamp),
      ...(token ? { "token-config": avContractId(deployed.tokenConfig) } : {}),
    },
  };

  const events = await api.exercise(
    addresses.receiverTemplate,
    receiver,
    "Execute",
    {
      routerCid: router,
      encodedMessage: bytesToHex(encoded),
      tokenTransfer: token
        ? {
            tokenPoolCid: deployed.tokenPool,
            tokenReceiverParty: token.tokenReceiverParty ?? receiverParty,
            // The pool resolves its own dependencies from this context, not the outer one.
            context: {
              values: {
                "rate-limiter": avContractId(deployed.inboundRateLimiter),
                "burn-mint-factory": avContractId(deployed.linkRegistry),
              },
            },
          }
        : null,
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

  // The pool releases the inbound ticket during execute, so a token message settles here.
  let holding;
  if (token) {
    const created = events.find((e) => e.templateId.endsWith(":LinkHolding") && e.acsDelta);
    if (!created) throw new Error("token message produced no holding; the pool did not settle");
    holding = {
      contractId: created.contractId,
      owner: created.createArgument?.holdingOwner,
      amount: created.createArgument?.holdingAmount,
    };
    log(`tokens released: ${holding.amount} to ${holding.owner}`);
  }

  // Execute consumes the router and creates a new one, so every delivery returns the next id.
  const nextRouter = events.find(
    (e) => e.templateId.endsWith(":PerPartyRouter") && e.acsDelta,
  );
  if (!nextRouter) throw new Error("receiver Execute produced no router");
  log(`message received ${received.contractId.slice(0, 16)}...`);

  return {
    messageId: id,
    encoded,
    messageReceived: received.contractId,
    holding,
    router: nextRouter.contractId,
    events,
  };
}

const avContractId = (contractId) => ({ tag: "AV_ContractId", value: contractId });

/** Full 32-byte big-endian word, so amounts are not capped at 64 bits. */
function word32(value) {
  const hex = BigInt(value).toString(16);
  if (hex.length > 64) throw new Error(`amount does not fit 32 bytes: ${value}`);
  return hexToBytes(hex.padStart(64, "0"));
}
