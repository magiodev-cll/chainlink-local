import anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import {
  EVM_CHAIN_SELECTOR,
  PROGRAM_IDS,
  SEEDS,
  SVM_CHAIN_SELECTOR,
  pda,
  u64LeBytes,
} from "./constants.js";
import { confirmSignature } from "./surfpool.js";

const { BN } = anchor;

export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CHAIN_FAMILY_SELECTOR_EVM = [0x28, 0x12, 0xd5, 0x2c];
const GENERIC_EXTRA_ARGS_V2_TAG = Buffer.from("181dcf10", "hex");

export interface OutboundHarness {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  linkMint: PublicKey;
  router: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  feeQuoter: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rmnRemote: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc(method: string, params: unknown[]): Promise<unknown>;
}

const routerId = new PublicKey(PROGRAM_IDS.ccipRouter);
const feeQuoterId = new PublicKey(PROGRAM_IDS.feeQuoter);
const rmnRemoteId = new PublicKey(PROGRAM_IDS.rmnRemote);

const routerConfig = pda([Buffer.from(SEEDS.config)], routerId);
const feeQuoterConfig = pda([Buffer.from(SEEDS.config)], feeQuoterId);
const feeBillingSigner = pda([Buffer.from("fee_billing_signer")], routerId);

async function sendTx(h: OutboundHarness, tx: Transaction, signers: Keypair[] = []) {
  tx.feePayer = h.payer.publicKey;
  tx.recentBlockhash = (await h.connection.getLatestBlockhash()).blockhash;
  tx.sign(h.payer, ...signers);
  const signature = await h.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await confirmSignature(h.connection, signature);
}

/** EVM destination lane config; gas fields are zero, so the quoted fee is zero. */
function destChainConfig() {
  // `CrossChainGas` and `UsdCents` are single-field newtypes; the coder wants `{ 0: value }`.
  const gas = (n: number) => ({ 0: n });
  return {
    isEnabled: true,
    laneCodeVersion: { v1: {} },
    maxNumberOfTokensPerMsg: 1,
    maxDataBytes: 10_000,
    maxPerMsgGasLimit: gas(1_000_000),
    destGasOverhead: gas(150_000),
    destGasPerPayloadByteBase: gas(16),
    destGasPerPayloadByteHigh: gas(0),
    destGasPerPayloadByteThreshold: 0,
    destDataAvailabilityOverheadGas: gas(0),
    destGasPerDataAvailabilityByte: 0,
    destDataAvailabilityMultiplierBps: 0,
    defaultTokenFeeUsdcents: 0,
    defaultTokenDestGasOverhead: gas(50_000),
    defaultTxGasLimit: gas(200_000),
    gasMultiplierWeiPerEth: new BN(0),
    networkFee: gas(0),
    gasPriceStalenessThreshold: 0,
    enforceOutOfOrder: false,
    chainFamilySelector: Buffer.from(CHAIN_FAMILY_SELECTOR_EVM),
  };
}

const u224 = (value: bigint) => {
  const out = Buffer.alloc(28);
  const hex = value.toString(16).padStart(56, "0");
  Buffer.from(hex, "hex").copy(out);
  return out;
};
// A dollar-ish price per token; zero is rejected as InvalidTokenPrice.
const TOKEN_PRICE = u224(10n ** 18n);
const GAS_PRICE = u224(1n);

/** Configure a one-way EVM lane on the Router and FeeQuoter. Idempotent per process. */
export async function configureSendLane(h: OutboundHarness): Promise<void> {
  const authority = h.payer.publicKey;
  const selector = new BN(EVM_CHAIN_SELECTOR.toString());
  const sel = u64LeBytes(EVM_CHAIN_SELECTOR);

  await sendTx(
    h,
    await h.feeQuoter.methods
      .addDestChain(selector, destChainConfig())
      .accounts({
        config: feeQuoterConfig,
        destChain: pda([Buffer.from("dest_chain"), sel], feeQuoterId),
        authority,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );

  // The router emits CCIPMessageSent through RMN's `cpi_event`, signed by its fee billing signer.
  await sendTx(
    h,
    await h.rmnRemote.methods
      .setEventAuthorities([feeBillingSigner])
      .accounts({
        config: pda([Buffer.from(SEEDS.config)], rmnRemoteId),
        authority,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );

  await sendTx(
    h,
    await h.router.methods
      .addChainSelector(selector, {
        laneCodeVersion: { v1: {} },
        allowedSenders: [],
        allowListEnabled: false,
      })
      .accounts({
        destChainState: pda([Buffer.from("dest_chain_state"), sel], routerId),
        config: routerConfig,
        authority,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );

  // `ccip_send` requires a billing config for both the fee token and LINK.
  for (const mint of [WSOL_MINT, h.linkMint]) {
    const receiver = getAssociatedTokenAddressSync(mint, feeBillingSigner, true);
    const exists = await h.connection.getAccountInfo(receiver);
    if (!exists) {
      const { createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(authority, receiver, feeBillingSigner, mint),
      );
      await sendTx(h, tx);
    }
    await sendTx(
      h,
      await h.feeQuoter.methods
        .addBillingTokenConfig({
          enabled: true,
          mint,
          usdPerToken: { value: TOKEN_PRICE, timestamp: new BN(0) },
          premiumMultiplierWeiPerEth: new BN(0),
        })
        .accounts({
          config: feeQuoterConfig,
          billingTokenConfig: pda([Buffer.from("fee_billing_token_config"), mint.toBuffer()], feeQuoterId),
          tokenProgram: TOKEN_PROGRAM_ID,
          feeTokenMint: mint,
          feeTokenReceiver: receiver,
          authority,
          feeBillingSigner,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .transaction(),
    );
  }

  // Fresh zero prices, so the staleness check in `get_fee` passes.
  const priceUpdater = pda([Buffer.from("allowed_price_updater"), authority.toBuffer()], feeQuoterId);
  await sendTx(
    h,
    await h.feeQuoter.methods
      .addPriceUpdater(authority)
      .accounts({
        allowedPriceUpdater: priceUpdater,
        config: feeQuoterConfig,
        authority,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );
  await sendTx(
    h,
    await h.feeQuoter.methods
      .updatePrices(
        [WSOL_MINT, h.linkMint].map((mint) => ({ sourceToken: mint, usdPerToken: TOKEN_PRICE })),
        [{ destChainSelector: selector, usdPerUnitGas: GAS_PRICE }],
      )
      .accounts({ authority, allowedPriceUpdater: priceUpdater, config: feeQuoterConfig })
      .remainingAccounts(
        [WSOL_MINT, h.linkMint]
          .map((mint) => ({
            pubkey: pda([Buffer.from("fee_billing_token_config"), mint.toBuffer()], feeQuoterId),
            isSigner: false,
            isWritable: true,
          }))
          .concat([
            {
              pubkey: pda([Buffer.from("dest_chain"), u64LeBytes(EVM_CHAIN_SELECTOR)], feeQuoterId),
              isSigner: false,
              isWritable: true,
            },
          ]),
      )
      .transaction(),
  );
}

export interface SendOptions {
  /** EVM receiver address bytes (20 bytes). */
  receiver: Uint8Array;
  data: string | Uint8Array;
  destChainSelector?: bigint;
  gasLimit?: number;
}

/** Send an arbitrary-data message from Solana to the configured EVM lane. */
export async function sendMessage(h: OutboundHarness, opts: SendOptions) {
  const destChainSelector = opts.destChainSelector ?? EVM_CHAIN_SELECTOR;
  const sel = u64LeBytes(destChainSelector);
  const authority = h.payer.publicKey;
  const data = typeof opts.data === "string" ? Buffer.from(opts.data) : Buffer.from(opts.data);

  // Legacy abi-encoded gas limit; the offchain executor interprets extra args.
  const gasLimit = Buffer.alloc(32);
  gasLimit.writeUInt32BE(opts.gasLimit ?? 200_000, 28);
  const extraArgs = Buffer.concat([GENERIC_EXTRA_ARGS_V2_TAG, gasLimit]);

  // EVM receivers travel abi-encoded: the 20-byte address left-padded to 32.
  const receiver = Buffer.concat([Buffer.alloc(32 - opts.receiver.length), Buffer.from(opts.receiver)]);
  const message = {
    receiver,
    data,
    tokenAmounts: [],
    feeToken: PublicKey.default,
    extraArgs,
  };

  const tx: Transaction = await h.router.methods
    .ccipSend(new BN(destChainSelector.toString()), message, Buffer.alloc(0))
    .accounts({
      config: routerConfig,
      destChainState: pda([Buffer.from("dest_chain_state"), sel], routerId),
      nonce: pda([Buffer.from("nonce"), sel, authority.toBuffer()], routerId),
      authority,
      systemProgram: SystemProgram.programId,
      feeTokenProgram: TOKEN_PROGRAM_ID,
      feeTokenMint: WSOL_MINT,
      feeTokenUserAssociatedAccount: PublicKey.default,
      feeTokenReceiver: getAssociatedTokenAddressSync(WSOL_MINT, feeBillingSigner, true),
      feeBillingSigner,
      feeQuoter: feeQuoterId,
      feeQuoterConfig,
      feeQuoterDestChain: pda([Buffer.from("dest_chain"), sel], feeQuoterId),
      feeQuoterBillingTokenConfig: pda(
        [Buffer.from("fee_billing_token_config"), WSOL_MINT.toBuffer()],
        feeQuoterId,
      ),
      feeQuoterLinkTokenConfig: pda(
        [Buffer.from("fee_billing_token_config"), h.linkMint.toBuffer()],
        feeQuoterId,
      ),
      rmnRemote: rmnRemoteId,
      rmnRemoteCurses: pda([Buffer.from(SEEDS.curses)], rmnRemoteId),
      rmnRemoteConfig: pda([Buffer.from(SEEDS.config)], rmnRemoteId),
    })
    // `#[event_cpi]` accounts: the router emits CCIPMessageSent via CPI.
    .remainingAccounts([
      { pubkey: pda([Buffer.from("__event_authority")], routerId), isSigner: false, isWritable: false },
      { pubkey: routerId, isSigner: false, isWritable: false },
    ])
    .transaction();

  tx.feePayer = authority;
  tx.recentBlockhash = (await h.connection.getLatestBlockhash()).blockhash;
  tx.sign(h.payer);
  const signature = await h.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await confirmSignature(h.connection, signature);

  const info = await h.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const prefix = `Program return: ${PROGRAM_IDS.ccipRouter} `;
  const line = (info?.meta?.logMessages ?? []).find((l) => l.startsWith(prefix));
  const messageId = line ? Buffer.from(line.slice(prefix.length), "base64").toString("hex") : null;

  return {
    signature,
    messageId,
    sourceChainSelector: SVM_CHAIN_SELECTOR,
    destChainSelector,
    sender: authority.toBuffer(),
    data,
  };
}
