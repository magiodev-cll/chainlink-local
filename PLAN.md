# Chainlink Local — Solana / SVM plan

One file: decision, what works, what is left, and the facts that were expensive to learn.

Status: 2.0 local path implemented. Branch `feat/svm-local`, base `main` @ `af2b3da`, `v0.3.1`.
Code in `src/ccip-svm/`, tests in `src/ccip-svm/test/` (9 passing), CI in
`.github/workflows/solana-test.yml`.

## Decision

Ship CCIP SVM support in this repo as a sibling package at `src/ccip-svm/`, published as
`@chainlink/local-solana`, released on `solana-v*` tags, with a path-filtered CI workflow.

Target **both** CCIP Solana program versions: **2.0 first** (done), **1.6 second** (deferred to a
stacked branch).

### Why not a separate repo

1. Precedent: `chainlink-ccip` hosts `chains/evm` and `chains/solana` in one repo with independent
   release tags (`solana-v1.6.2`). Same problem, same pattern.
2. DevRel already works here (`test.yml` has a `devrel-205/**` push trigger).
3. Docs and brand: `docs.chain.link/chainlink-local/build/ccip/{foundry,hardhat}` extends to
   `.../anchor` instead of forking the product name.
4. The two halves need each other: SVM→EVM outbound reuses `CCIPLocalRouter.routeMessage`, which
   is already public and unauthenticated.
5. Version coupling is solved with a tag prefix, not a repo split.

The package is self-contained (no imports from the root package), so the decision stays
reversible: it can be lifted into its own repo in a day.

## Layout

```
src/ccip-svm/
  package.json               # @chainlink/local-solana
  src/
    artifacts.ts             # pinned program IDs, download + sha256, cache
    codec.ts                 # MessageV1 encode/decode, dest blob, CCV signing
    constants.ts             # program IDs, seeds, selectors
    evm.ts                   # deliverToEvm + message conversion
    outbound.ts              # Router lane config + send
    resolver.ts              # staged resolve_accounts_* client
    simulator.ts             # CcipSvmLocal: start, bootstrap, deliver, send
    surfpool.ts              # spawn/attach, deployProgram, setAccount, setProgramAuthority
    tokens.ts                # BurnMint pool + mint fixture
  test/                      # codec, evm helper, end-to-end
  spike/                     # throwaway probes kept as evidence
.github/workflows/solana-test.yml    # paths: ['src/ccip-svm/**']
```

`forge` (`src = 'src'`, compiles `.sol` only), Hardhat (`paths.sources: ./src`) and the root npm
`files` list (`src/**/*.sol`) all ignore non-Solidity content under `src/`, so this is additive
and does not affect the EVM package.

## Progress

| Milestone | Status |
|---|---|
| M0 spike: real programs on Surfpool, local trust layer | done |
| M1 core + 2.0 inbound data, failure path, CI | done |
| M2 2.0 inbound BurnMint tokens | done |
| M4 SVM→EVM local, data-only (`send()` v1 + `deliverToEvm()`) | done |
| M4b 2.0 send lane (`ccip_send_v2`) | partial: lane config and executor done, account resolution fails |
| M3 1.6 adapter | not started, deferred to a stacked branch |
| M5 SVM→EVM devnet fork | not started |
| Outbound token transfers | not started, cause narrowed |

Tests: 9 passing (`npm test` in `src/ccip-svm`). CI: `CCIP SVM simulator` job, ~25 s.

### Evidence M0

The go/no-go rested on three things, all confirmed:

- 6 real 2.0 programs deploy as executable in **68 ms** via `surfnet_writeProgram`; no Docker, no
  Rust, no Anchor CLI, no network.
- A local key takes the program upgrade authority and runs the whole trust layer:
  OffRamp init → RMN → FeeQuoter → Router + `allowed_offramp` → CommitteeVerifier + chain and
  signer config → source chain. 13 consecutive on-chain transactions.
- A message executes end to end: staged account resolution → `execute_v2` → CommitteeVerifier
  `verify` → receiver CPI.

## Architecture

Use the real programs. Simulate only the off-chain trust layer.

```
message DSL → encoded message (+ leaf/root for 1.6, verifier results for 2.0)
  → 2.0: resolve_accounts_* → execute_v2 → pool release/mint + receiver CPI
  → 1.6: commit (local OCR3) → derive_accounts_execute → execute → pool + receiver CPI
  → assert execution state, receiver state, SPL balances
```

Real: OffRamp, Router, FeeQuoter, RMNRemote, CommitteeVerifier, Executor, token pools, receiver
CPI, SPL transfers, execution states, production error codes.

Simulated: commit attestations, CCV signatures, RMN cursing, source-chain finality, fee quotes,
lane config.

Rejected alternative: a mock OffRamp that only CPIs the receiver. It drifts, cannot model token
pools, and costs more to maintain than deploying the real `.so` files.

### Direction × mode

| Direction | Local | Fork |
|---|---|---|
| EVM → SVM | Yes: real OffRamp + pools + receiver CPI, locally owned committee/CCVs | **Not possible.** The destination OffRamp only accepts Chainlink's committee/CCVs. |
| SVM → EVM | Yes: real SVM Router send → capture → EVM `CCIPLocalRouter.routeMessage` | Yes: real Router on a devnet fork → `CCIPLocalSimulatorFork` on the EVM side |

Inbound fork mode is a trust-model limit, not an implementation gap: there is no key to sign a
commitment with. Do not promise it in docs.

## Version matrix

|  | 1.6.2 | 2.0 |
|---|---|---|
| Status | Live on mainnet/devnet since May 2026 | Devnet now; mainnet Q4'26–Q1'27 |
| Artifacts | Tag `solana-v1.6.2`, sha256 pinned | Rolling `latest` prerelease + `executable-hashes.txt` |
| OffRamp ID | `offqSMQWgQud6WJz694LRzkeN5kMYpCHTpXQr3Rkcjm` | `off43sBHBsmWTU6VbfwKYCNwyJ4rSDhunYvz3QL7bF9` |
| Router ID | `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C` | same address, different binary |
| Inbound path | `commit` (OCR3) → `derive_accounts_execute` → `execute` | `resolve_accounts_*` → `execute_v2` with inline verifier results |
| Why keep it | Upgrade migrations and existing lanes | Every new lane lands here |

The two adapters cannot share one Surfpool instance: the router address is the same but the
binaries differ. One adapter per process.

The 1.6.2 binaries deploy and report `executable: true` on Surfpool 1.7 — the runtime is not a
risk.

## Backlog

Ordered, with the first concrete step for each.

1. **2.0 send lane (`ccip_send_v2`).** `add_dest_chain_v2` and `upsert_dest_chain_config_v2` work;
   the executor program is deployed and configured. `ccip_send_v2` resolves through the generic
   `resolve_accounts_start` chain and fails at `resolve_accounts_executor_stage` with
   `InvalidInstructionData` (7033). Next: read `parse_onramp_resolution_inputs` and the stage
   before it.
2. **Outbound token transfers.** The Router's `derive_accounts_ccip_send` works and `token_indexes`
   are start offsets. Sending a token fails inside the pool's `lock_or_burn` with
   `owner does not match`. Next: take the derived list verbatim and try a token-denominated fee
   with the billing-signer approval.
3. **1.6 adapter.** Next: read whether 1.6 `setOcrConfig` accepts
   `is_signature_verification_enabled = 0`; that single flag decides the size of the work.
4. **Polish.** CODEOWNERS for `src/ccip-svm/`, a docs page under
   `chainlink-local/build/ccip/anchor`, and a decision on artifact pinning.

Non-goals: RMN cursing, real committee security, fee accuracy, finality/latency semantics, CCTP,
multi-validator, MEV, mainnet anything.

## API

```ts
import { CcipSvmLocal, deliverToEvm } from "@chainlink/local-solana";

const sim = await CcipSvmLocal.start();          // spawns Surfpool, deploys the real programs

await sim.deliver({ data: "hello from ethereum" });

const { mint } = await sim.createBurnMintToken();
await sim.deliver({ data: "tokens", token: { mint, amount: 7n } });

const sent = await sim.send({ receiver: receiverBytes20, data: "hello evm" });
await deliverToEvm({ router, message, receiver });  // any EVM node

await sim.stop();
```

`deliver()` accepts `receiverProgram`, `receiverAccounts`, `receiverWritableBitmap`,
`onRampAddress`, `sourceChainSelector`, `sender` and `messageNumber` for receivers that declare
their own accounts. `start({ surfpoolUrl })` attaches to an existing instance instead of spawning
one; `start({ surfpoolBin, artifacts })` pins the binary and the artifact bundle.

## Tooling and CI

- Node 22 floor, TypeScript.
- Surfpool pinned by exact release binary + checksum (or Docker tag). Never the `curl | bash`
  installer in CI: it always installs latest and Surfpool ships breaking cheatcode changes.
- `--no-tui --no-studio --offline`. No network for the consumer beyond the first artifact fetch.
- Program artifacts fetched once from the pinned release with sha256, cached.
- No Rust, no Anchor CLI, no Docker required from consumers.
- CI: `ubuntu-latest`, `paths: ['src/ccip-svm/**']`, 10 min timeout.

## Risks

1. Program/version drift: 1.6 → 2.0 invalidates encoders. Mitigated by a stable public API over
   per-version internals, pinned bundles, and deliberate bumps.
2. 2.0 artifacts are a rolling prerelease. The digest is pinned; a bump is deliberate.
3. Fidelity illusion: local pass ≠ mainnet pass. Mitigated by the real-vs-simulated split above.
4. Surfpool is third-party and fast-moving. Keep the validator behind an adapter so
   `solana-test-validator` works as a fallback.
5. Licensing: `chainlink-ccip` declares BUSL for some paths; `chains/solana` is not listed but the
   LICENSE is ambiguous. Do not bundle `.so` files in the npm tarball until legal confirms.
   Fetch-at-setup with pinned hashes is the default.
6. Ownership: DevRel owns it, CCIP Solana reviews. Needs a CODEOWNERS entry.

## Open decisions

1. **Licensing** sign-off on redistributing program artifacts. Current default is fetch-at-setup
   with a pinned sha256, so nothing is bundled in the npm tarball.
2. **Artifact pinning policy.** The 2.0 bundle is the upstream rolling `latest` release, pinned by
   digest. Keep that, or move to a commit SHA?
3. **1.6 packaging.** Ship it as a second adapter in this package, or as a stacked branch that
   lands only if migrations need it.
4. **Fidelity default.** Signatures are verified with a locally generated committee today. Keep
   that, or add a faster "signatures off" mode?

Decided already: sibling package in this repo; 2.0 first; inbound fork mode is not offered.

## Appendix: facts that were expensive to learn

**Wire format.** The 2.0 message is a custom versioned big-endian codec, **not borsh**:
`u8 version, u64 source, u64 dest, u64 messageNumber, u32 execGas, u32 receiveGas, u16 flags,
u16 blockDepth, [32] ccvAndExecutorHash, u8-len onRamp, u8-len offRamp, u8-len sender,
u8-len receiver, u16-len destBlob, u16-len tokenTransfer, u16-len data`. `message_id = keccak(bytes)`.

**CCV signatures.** `verifier_results = u8[4] version_tag | u16 BE sig_len | N × 64-byte sigs`,
tag `e9a05a20`. Signed hash is `keccak(tag || message_id)`. The on-chain verifier always recovers
with `recovery_id = 0`, so signatures whose natural `v` is 28 are normalised by flipping `s` to
`n - s`. `ethers` `SigningKey.sign()` works; `@noble/curves` recovered-format signatures were
rejected on chain even though they recovered correctly off chain.

**Account resolution.** Two protocols exist. The offramp and `ccip_send_v2` use the **generic**
`resolve_accounts_start` chain (discriminator + borsh `{caller, ix_data, metadata}`, staged via
`next_ix_discriminator`). The v1 Router send uses `derive_accounts_ccip_send` with **string**
stages (`Start`, `TransferTokenStaticAccounts/<i>/<page>`, ...) and returns account metas directly.

**Anchor encoding traps.** Enums are `{ v1: {} }` after the IDL is camelCased (not `{ V1: {} }`,
not `"V1"`). Single-field newtypes are `{ 0: value }`. `u64`/`i64` need `BN`. Fixed byte arrays
need `Buffer`.

**Pool registration.** The router's token admin registry requires a lookup table with a mandatory
ten-account prefix and writable indexes for the pool state, pool ATA and mint; otherwise the pool
CPI reverts with `ConstraintMut`. Pool v1 rejects `UseAsIs` token receivers — the ATA must be
derived from a wallet.

**Surfpool specifics.** `surfnet_writeProgram` deploys a `.so` at an arbitrary address but leaves
no upgrade authority; `surfnet_setProgramAuthority` must set one before any program checks it.
`surfnet_setAccount` covers fixtures that normally arrive as validator genesis accounts.
`confirmTransaction` relies on WebSocket subscriptions, so poll `getSignatureStatuses` instead and
fix the WS port when an Anchor provider is involved.

**Determinism.** Identical message bytes produce an identical message id; a receiver that tracks
processed ids treats a repeat as a no-op. `deliver({ messageNumber })` exists to make repeats
distinct.
