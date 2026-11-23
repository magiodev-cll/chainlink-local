// Outbound lane configuration. A message cannot be prepared until the global config, the fee quoter
// and the on-ramp agree on the destination selector, so this is the first thing the send path needs.

import { PACKAGES } from "./bootstrap.js";

export async function configureDestLane({
  api,
  owner,
  deployed,
  destChainSelector,
  offRampAddress = "11".repeat(20),
  committeeVerifier,
  log = () => {},
}) {
  const withGlobalConfig = await api.exercise(
    GLOBAL_CONFIG,
    deployed.globalConfig,
    "ApplyDestChainConfigUpdates",
    {
      destChainConfigUpdates: [
        {
          destChainSelector,
          isEnabled: true,
          addressBytesLength: 20,
          tokenReceiverAllowed: false,
          baseExecutionGasCost: 150_000,
          offRampAddress: offRampAddress,
          defaultExecutor: null,
          laneMandatedCCVs: [committeeVerifier],
          defaultCCVs: [],
          messageNetworkFeeUSDCents: "0",
          tokenNetworkFeeUSDCents: "0",
        },
      ],
    },
    owner,
  );
  const globalConfig = withGlobalConfig.find(
    (e) => e.templateId.endsWith(":GlobalConfig") && e.acsDelta,
  );
  if (!globalConfig) throw new Error("ApplyDestChainConfigUpdates produced no GlobalConfig");

  const withFeeQuoter = await api.exercise(
    FEE_QUOTER,
    deployed.feeQuoter,
    "ApplyFeeQuoterDestChainConfigUpdates",
    {
      destChainConfigArgs: [
        {
          destChainSelector,
          destChainConfig: {
            isEnabled: true,
            maxDataBytes: 30_000,
            maxPerMsgGasLimit: 3_000_000,
            destGasOverhead: 150_000,
            destGasPerPayloadByteBase: 16,
            defaultTxGasLimit: 200_000,
            linkFeeMultiplierPercent: "100",
            defaultTokenFeeUSD: "0",
            defaultTokenDestGasOverhead: 50_000,
          },
        },
      ],
    },
    owner,
  );
  const feeQuoter = withFeeQuoter.find(
    (e) => e.templateId.endsWith(":FeeQuoter") && e.acsDelta,
  );
  if (!feeQuoter) throw new Error("ApplyFeeQuoterDestChainConfigUpdates produced no FeeQuoter");

  // A fee quote needs a gas price for the lane and a price for the fee token.
  const withPrices = await api.exercise(
    FEE_QUOTER,
    feeQuoter.contractId,
    "UpdatePrices",
    {
      priceUpdates: {
        tokenPriceUpdates: [{ instrumentId: { admin: owner, id: "LINK" }, usdPerToken: "1.0" }],
        gasPriceUpdates: [{ destChainSelector, usdPerUnitGas: "0.000000001" }],
      },
      caller: owner,
    },
    owner,
  );
  const pricedFeeQuoter = withPrices.find(
    (e) => e.templateId.endsWith(":FeeQuoter") && e.acsDelta,
  );
  if (!pricedFeeQuoter) throw new Error("UpdatePrices produced no FeeQuoter");

  // Both choices are consuming, so the caller's ids are stale from here on.
  deployed.globalConfig = globalConfig.contractId;
  deployed.feeQuoter = pricedFeeQuoter.contractId;

  log("outbound lane configured");

  return {
    globalConfig: globalConfig.contractId,
    feeQuoter: pricedFeeQuoter.contractId,
  };
}

export const GLOBAL_CONFIG = `${PACKAGES.core}:CCIP.CoreV2.GlobalConfig:GlobalConfig`;
export const FEE_QUOTER = `${PACKAGES.core}:CCIP.CoreV2.FeeQuoter:FeeQuoter`;
