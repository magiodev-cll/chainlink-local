// Sends a CCIP message from Canton: mint a fee holding, prepare and price the message, then send.

import { PACKAGES } from "./bootstrap.js";

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
  log = () => {},
}) {
  const instrumentId = { admin: owner, id: "LINK" };

  const minted = await api.exercise(
    BURN_MINT_FACTORY,
    deployed.linkRegistry,
    "BurnMintFactory_BurnMint",
    {
      expectedAdmin: owner,
      instrumentId,
      inputHoldingCids: [],
      outputs: [{ owner, amount: feeAmount, context: { values: {} } }],
      extraActors: [],
      extraArgs: { context: { values: {} }, meta: { values: {} } },
    },
    owner,
  );
  const holding = minted.find((e) => e.templateId.endsWith(":LinkHolding") && e.acsDelta);
  if (!holding) throw new Error("burn/mint produced no LinkHolding");

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

  const prepared = await api.exercise(
    addresses.routerTemplate,
    router,
    "PrepareSend",
    {
      destinationChainSelector: destChainSelector,
      message: {
        receiver,
        payload,
        tokenTransfer: null,
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

  // Fee is priced while the message is still Prepared, one call per mandated CCV.
  const pricedByCcv = await api.exercise(
    COMMITTEE_VERIFIER,
    deployed.committeeVerifier,
    "CalculateFee",
    { sendingMessageCid: current.contractId, context, caller: owner },
    owner,
  );
  current = sendingMessageOf(pricedByCcv);

  const finalized = await api.exercise(
    addresses.routerTemplate,
    router,
    "FinalizeFee",
    { sendingMessageCid: current.contractId, context },
    owner,
  );
  current = sendingMessageOf(finalized);

  // Verifier data can only be attached after finalisation.
  const forwarded = await api.exercise(
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

  const sent = await api.exercise(
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
  log("message sent from Canton");

  return { router: nextRouter.contractId };
}

export const BURN_MINT_FACTORY = `${PACKAGES.burnMint}:Splice.Api.Token.BurnMintV1:BurnMintFactory`;
export const COMMITTEE_VERIFIER = `${PACKAGES.committeeVerifier}:CCIP.CommitteeVerifierV2:CommitteeVerifier`;

function sendingMessageOf(events) {
  const message = events.find((e) => e.templateId.endsWith(":SendingMessage") && e.acsDelta);
  if (!message) throw new Error("router produced no SendingMessage");
  return message;
}

const av = (contractId) => ({ tag: "AV_ContractId", value: contractId });
