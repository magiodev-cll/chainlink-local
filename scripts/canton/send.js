// Sends a CCIP message from Canton: mint a fee holding, prepare and price the message, then send.

import { PACKAGES, POOL_INSTANCE_ID, POOL_TEMPLATE } from "./bootstrap.js";
import { bytesToHex } from "./codec.js";
import { withDisclosures } from "./sandbox.js";

export async function send({
  api,
  owner,
  router,
  deployed,
  addresses,
  destChainSelector,
  receiver,
  payload = "",
  gasLimit = 200_000,
  feeAmount = "10000.0",
  token,
  disclosures = [],
  log = () => {},
}) {
  const ledgerApi = withDisclosures(api, disclosures);
  const instrumentId = { admin: owner, id: "LINK" };

  const holding = await mintHolding(ledgerApi, owner, deployed, feeAmount, "fee");

  const transferHolding = token
    ? await mintHolding(ledgerApi, owner, deployed, token.amount, "transfer")
    : undefined;

  const context = {
    values: {
      "on-ramp": av(deployed.onRamp),
      "global-config": av(deployed.globalConfig),
      "token-admin-registry": av(deployed.tokenAdminRegistry),
      "fee-quoter": av(deployed.feeQuoter),
      "rmn-remote": av(deployed.rmnRemote),
      "token-config": av(deployed.tokenConfig),
    },
  };

  const prepared = await ledgerApi.exercise(
    addresses.routerTemplate,
    router,
    "PrepareSend",
    {
      destinationChainSelector: destChainSelector,
      message: {
        receiver,
        payload,
        tokenTransfer: token ? { token: instrumentId, amount: token.amount } : null,
        feeToken: instrumentId,
        extraArgs: {
          tag: "V3",
          value: {
            gasLimit,
            ccvs: [],
            executor: { tag: "Executor_NoExecutor", value: {} },
            tokenReceiver: "",
            tokenArgs: "",
          },
        },
      },
      context,
    },
    owner,
  );
  let current = sendingMessageOf(prepared);

  // The pool resolves its outbound CCVs, then quotes its fee, both while the message is open.
  if (token) {
    current = sendingMessageOf(
      await ledgerApi.exercise(
        POOL_TEMPLATE,
        deployed.tokenPool,
        "VerifyOutboundCCVs",
        {
          tokenAdminRegistryCid: deployed.tokenAdminRegistry,
          tokenConfigCid: deployed.tokenConfig,
          sendingMessageCid: current.contractId,
          amount: token.amount,
          context,
          caller: owner,
        },
        owner,
      ),
    );

    current = sendingMessageOf(
      await ledgerApi.exercise(
        POOL_TEMPLATE,
        deployed.tokenPool,
        "CalculateFee",
        {
          tokenAdminRegistryCid: deployed.tokenAdminRegistry,
          tokenConfigCid: deployed.tokenConfig,
          sendingMessageCid: current.contractId,
          feeQuoterCid: deployed.feeQuoter,
          tokenInstrumentId: instrumentId,
          context,
          caller: owner,
        },
        owner,
      ),
    );
  }

  // Fee is priced while the message is still Prepared, one call per mandated CCV.
  const pricedByCcv = await ledgerApi.exercise(
    COMMITTEE_VERIFIER,
    deployed.committeeVerifier,
    "CalculateFee",
    { sendingMessageCid: current.contractId, context, caller: owner },
    owner,
  );
  current = sendingMessageOf(pricedByCcv);

  const finalized = await ledgerApi.exercise(
    addresses.routerTemplate,
    router,
    "FinalizeFee",
    { sendingMessageCid: current.contractId, context },
    owner,
  );
  current = sendingMessageOf(finalized);

  // A token transfer is locked or burned only once the fee is finalised.
  if (token) {
    const locked = await ledgerApi.exercise(
      POOL_TEMPLATE,
      deployed.tokenPool,
      "LockOrBurn",
      {
        tokenAdminRegistryCid: deployed.tokenAdminRegistry,
        tokenConfigCid: deployed.tokenConfig,
        rmnRemoteCid: deployed.rmnRemote,
        sendingMessageCid: current.contractId,
        senderInputCids: [transferHolding.contractId],
        amount: token.amount,
        context: {
          values: {
            "burn-mint-factory": av(deployed.linkRegistry),
            "rate-limiter": av(deployed.outboundRateLimiter),
          },
        },
        caller: owner,
      },
      owner,
    );
    const lockedMessage = locked.find((e) => e.templateId.endsWith(":SendingMessage") && e.acsDelta);
    if (lockedMessage) current = lockedMessage;
  }

  // Verifier data can only be attached after finalisation.
  const forwarded = await ledgerApi.exercise(
    COMMITTEE_VERIFIER,
    deployed.committeeVerifier,
    "ForwardToVerifier",
    {
      rmnRemoteCid: deployed.rmnRemote,
      context,
      sendingMessageCid: current.contractId,
      verifierArgs: "",
      caller: owner,
    },
    owner,
  );
  current = sendingMessageOf(forwarded);

  const sent = await ledgerApi.exercise(
    addresses.routerTemplate,
    router,
    "CCIPSend",
    {
      sendingMessageCid: current.contractId,
      feeTokenHoldingCids: [holding.contractId],
      feeTokenConfigCid: deployed.tokenConfig,
      feeTokenTransferFactory: deployed.linkRegistry,
      feeTokenExtraArgs: { context: { values: {} }, meta: { values: {} } },
      context,
    },
    owner,
  );

  // CCIPSend consumes the router, so the next send needs the id it returns.
  const nextRouter = sent.find((e) => e.templateId.endsWith(":PerPartyRouter") && e.acsDelta);
  if (!nextRouter) throw new Error("CCIPSend produced no router");

  // The wire message is carried by the CCIPMessageSent event contract.
  const sentEvent = sent.find((e) => e.templateId.endsWith(":CCIPMessageSent"));
  if (!sentEvent) throw new Error("CCIPSend produced no CCIPMessageSent");
  const event = sentEvent.createArgument?.event;
  if (!event?.encodedMessage) throw new Error("CCIPMessageSent carries no encodedMessage");

  log(`message sent from Canton: ${event.messageId}`);

  return {
    router: nextRouter.contractId,
    messageId: event.messageId,
    encodedMessage: event.encodedMessage,
    sequenceNumber: event.sequenceNumber,
    messageSent: sentEvent.contractId,
  };
}

export const BURN_MINT_FACTORY = `${PACKAGES.burnMint}:Splice.Api.Token.BurnMintV1:BurnMintFactory`;
export const COMMITTEE_VERIFIER = `${PACKAGES.committeeVerifier}:CCIP.CommitteeVerifierV2:CommitteeVerifier`;

function sendingMessageOf(events) {
  const message = events.find((e) => e.templateId.endsWith(":SendingMessage") && e.acsDelta);
  if (!message) throw new Error("router produced no SendingMessage");
  return message;
}

const av = (contractId) => ({ tag: "AV_ContractId", value: contractId });
export const SENDING_MESSAGE = `${PACKAGES.core}:CCIP.CoreV2.SendingMessage:SendingMessage`;

/** Daml amounts are decimals; CCIP payloads use base units at 10 decimals. */
function decimalsToBaseUnits(amount) {
  const [whole, fraction = ""] = String(amount).split(".");
  return BigInt(whole + fraction.padEnd(10, "0").slice(0, 10));
}

function word32(value) {
  const hex = BigInt(value).toString(16);
  if (hex.length > 64) throw new Error(`amount does not fit 32 bytes: ${value}`);
  return Buffer.from(hex.padStart(64, "0"), "hex");
}

async function mintHolding(ledgerApi, owner, deployed, amount, label) {
  const minted = await ledgerApi.exercise(
    BURN_MINT_FACTORY,
    deployed.linkRegistry,
    "BurnMintFactory_BurnMint",
    {
      expectedAdmin: owner,
      instrumentId: { admin: owner, id: "LINK" },
      inputHoldingCids: [],
      outputs: [{ owner, amount, context: { values: {} } }],
      extraActors: [],
      extraArgs: { context: { values: {} }, meta: { values: {} } },
    },
    owner,
  );
  const holding = minted.find((e) => e.templateId.endsWith(":LinkHolding") && e.acsDelta);
  if (!holding) throw new Error(`burn/mint produced no ${label} holding`);
  return holding;
}
