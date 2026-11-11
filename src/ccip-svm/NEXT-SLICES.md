# Remaining slices

What is left after the 2.0 inbound slice (data + BurnMint tokens), and exactly where to start.

## 1. SVM → EVM

The direction that completes the bridge. Two halves, and the EVM half already exists.

### 1a. Solana send (hard part)

**Status: done.** `sim.send()` configures the Router/FeeQuoter lane and sends through the real
Router; `evm.ts` is the other half. The account map below is kept as reference for the 1.6 port
and for debugging.

**Previously:** `evm.ts` is done. `deliverToEvm()` and `toAny2EvmMessage()` land and are unit
tested. Only the Solana send below remains.

#### Account map for `router.ccip_send` (v1 lane), derived from source

- `dest_chain_state`: `[b"dest_chain_state", u64le(selector)]` under the router
- `nonce`: `[b"nonce", u64le(selector), authority]` under the router
- `fee_token_mint`: `So11111111111111111111111111111111111111112` for native fees
- `fee_token_user_associated_account`: WSOL ATA of the sender
- `fee_token_receiver`: WSOL ATA of the router's **fee billing signer** PDA
- `fee_quoter_billing_token_config`: `[b"fee_billing_token_config", feeTokenMint]` under the
  fee quoter — **a hard seeds constraint, not optional**
- `fee_quoter_link_token_config`: `[b"fee_billing_token_config", linkMint]` under the fee
  quoter — also a hard constraint, which is why the bootstrap LINK mint must be persisted
- `fee_quoter_dest_chain`: `[b"dest_chain", u64le(selector)]` under the fee quoter

Native fees: the router rewrites `message.fee_token` to the native mint and transfers SOL to the
billing signer's ATA, so no token approval is needed.

#### Minimal configuration

1. `fee_quoter.add_dest_chain(selector, DestChainConfig { is_enabled: true, lane_code_version: 1,
   max_number_of_tokens_per_msg, max_data_bytes, max_per_msg_gas_limit, ...zeroed gas fields })`
2. `fee_quoter.add_billing_token_config` for **both** the native mint and the LINK mint, with
   `usd_per_token = [0;28]` and `premium_multiplier_wei_per_eth = 0`
3. `fee_quoter.add_price_updater(payer)` then `update_prices([], [{ selector, usd_per_unit_gas:
   [0;28] }])`, or confirm a zero default price is accepted and skip both
4. `router.add_chain_selector(selector, { lane_code_version: 1, allowed_senders: [],
   allow_list_enabled: false })`
5. `router.ccip_send(selector, { receiver, data, token_amounts: [], fee_token: PublicKey.default,
   extra_args }, [])` — `ccip_send` returns the message id as program return data

`router.ccip_send` (v1 lane) or `router.ccip_send_v2` (2.0 lane) on Surfpool. The v1 path is
simpler and enough for a local demo.

Required setup, none of which the harness does today:

1. **Router lane**: `router.add_chain_selector(destSelector, DestChainConfig { lane_code_version,
   allowed_senders, allow_list_enabled })`. v1 config is small.
2. **FeeQuoter dest chain**: `fee_quoter.add_dest_chain(selector, DestChainConfig { ... })`.
   The struct is large; zeros are acceptable except `is_enabled`, `lane_code_version`,
   `max_data_bytes` and the gas fields. `add_dest_chain` is admin-only.
3. **FeeQuoter billing token**: `fee_quoter.add_billing_token_config(BillingTokenConfig {
   enabled, mint, usd_per_token: TimestampedPackedU224 { value: [u8;28], timestamp: i64 },
   premium_multiplier_wei_per_eth })`. Needs an ATA for the fee receiver and the fee billing
   signer PDA.
4. **Link token mint must be persisted.** `bootstrap()` creates one for `fee_quoter.initialize`
   and throws it away. `ccip_send` requires `fee_quoter_link_token_config` to exist, so the mint
   must be stored on the instance and its billing config created. This is a small refactor:
   `private readonly linkMint: Keypair`.
5. **Price updater**: `fee_quoter.update_prices` requires the `allowed_price_updater` PDA. Either
   add one (`add_price_updater`) or rely on the default zero gas price and skip the call. Verify
   which by calling `get_fee` first; a zero fee avoids the whole price path.
6. **Native fee**: pass `fee_token: PublicKey.default` so the router charges SOL, avoiding the
   LINK approval path.

Then decode the emitted `CCIPMessageSent` CPI event into the 2.0 `MessageV1` wire format (the
codec already exists for the inbound direction; it needs a `decodeMessage` counterpart).

### 1b. EVM delivery (easy part)

`CCIPLocalRouter.routeMessage(Client.Any2EVMMessage, gasForCallExactCheck, gasLimit, receiver)`
is already public and unauthenticated. Add `deliverToEvm({ provider, routerAddress, message })`
in `src/ccip-svm/src/evm.ts`, taking any ethers v6 `Provider` and a minimal router ABI. No EVM
node is spawned by this package; the user brings one (Anvil/Foundry/Hardhat).

This half can be built and unit-tested today, independently of 1a.

## 2. CCIP 1.6 adapter

**Verified this session:** the `solana-v1.6.2` binaries deploy to Surfpool 1.7 and report
`executable: true` (offramp, router, fee quoter, rmn remote, test receiver). The runtime is not
a blocker.

Differences from 2.0 that shape the implementation:

- OffRamp id differs (`offqSMQ…` vs `off43sBHB…`); the **router id is the same** but the binary
  differs, so 1.6 and 2.0 cannot share a Surfpool instance. One adapter per process, already
  documented in the memo.
- Trust layer is OCR3, not CCV. Sequence:
  1. `offramp.initialize` + `initialize_config`
  2. `rmn_remote.initialize`, `fee_quoter.initialize`, `router.initialize` + `add_offramp`
  3. `offramp.set_ocr_config` with `f = 1` and, critically,
     `is_signature_verification_enabled = 0`. `ocr3_set` only requires `f != 0`; with
     verification off, `commit` needs no signatures at all, which removes the secp256k1
     recovery-parity work entirely.
  4. Build `CommitInput { price_updates: [], merkle_root: Some(MerkleRoot { ... }) }`,
     `raw_report = borsh(CommitInput)`, `report_context = [config_digest, 24 zero bytes || seq]`
  5. `offramp.commit(...)`
  6. `deriveAccountsExecute(params, stage)` then `execute`. **The 1.6 derive protocol differs
     from 2.0**: stages are strings passed as an argument (`"Start"`, `"FinishMainAccountList"`,
     `"RetrieveTokenLUTs"`, `"RetrievePoolPrograms"`, `"TokenTransferStaticAccounts{token,page}"`,
     `"NestedTokenDerive{..}"`), returned as `next_stage`, not a discriminator to call. It also
     pages. `execute` itself takes one `rawExecutionReport` =
     borsh(`ExecutionReportSingleChain { source_chain_selector, message, offchain_token_data,
     proofs }`), not separate message/proof arguments.
- `CommitInput { price_updates, merkle_root: Option<MerkleRoot>, rmn_signatures }`;
  `MerkleRoot { source_chain_selector, on_ramp_address: Vec<u8>, min_seq_nr, max_seq_nr,
  merkle_root: [u8;32] }`.
- Message encoding is `Any2SVMRampMessage` (`header { message_id, source, dest, sequence_number,
  nonce }`, `sender`, `data`, `token_receiver: Pubkey`, `token_amounts`, `extra_args
  { compute_units, is_writable_bitmap }`), and the leaf hash is **not** the 2.0 codec:
  `keccak(domain_separator || "Any2SVMMessageHashV1" || be(source) || be(dest) ||
  u16(onRamp.len) || onRamp || messageId || tokenReceiver || be(seq) || borsh(extraArgs) ||
  be(nonce) || u16(sender.len) || sender || u16(data.len) || data || borsh(tokenAmounts) ||
  remainingAccounts)`. Single-leaf merkle root = the leaf.
- The 1.6 `test_ccip_receiver` needs its router-level `allowed_offramp` PDA (same as 2.0) plus a
  per-sender approval PDA (`approve_sender`), unlike the 2.0 test receiver.

Reference: `chainlink-ccip/chains/solana/utils/ccip/ccip_messages.go` (`HashAny2SVMMessage`,
`MerkleFrom`, `SignCommitReport`).

## 3. Fork mode

- **Inbound (EVM → SVM): not possible.** A real OffRamp only accepts commitments from Chainlink's
  own committee/CCVs. There is no key to sign with. This is a trust-model limit, not an
  implementation gap. Do not promise it in docs.
- **Outbound (SVM → EVM): possible and valuable.** Fork devnet, use the real Router and lane
  config, capture the event, deliver on the EVM side with `CCIPLocalSimulatorFork`. Depends on
  slice 1a.

## Suggested order

1. `evm.ts` delivery helper (self-contained, testable).
2. 1a fee/router setup → `send()` → wire to the helper → end-to-end SVM → EVM test.
3. 1.6 adapter, reusing `resolveAccounts` and `confirmSignature`.
