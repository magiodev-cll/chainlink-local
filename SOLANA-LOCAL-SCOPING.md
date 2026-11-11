# Chainlink Local — Solana / SVM scoping

Status: decision memo + M0 spike results. No production code yet.
Branch: `feat/svm-local` (worktree `../chainlink-local-svm`), base `main` @ `af2b3da`, `v0.3.1`.

**M0 verdict: GO for 2.0.** The real programs deploy to Surfpool in ~100 ms and
a local key can own the full trust layer (RMN, FeeQuoter, Router, CommitteeVerifier)
with 13 consecutive passing on-chain transactions. See
[`src/ccip-svm/M0-FINDINGS.md`](src/ccip-svm/M0-FINDINGS.md) for evidence and the
three findings that change the implementation (non-Borsh message codec, CCV
signature parity selection, resolver is optional).

## Recommendation

Ship CCIP SVM support in this repo as a sibling package at `src/ccip-svm/`,
published as `@chainlink/local-solana`, released on `solana-v*` tags, with a
path-filtered CI workflow.

Target **both** CCIP Solana program versions: **2.0 first**, **1.6 second**.

## Why not a separate repo

1. Precedent: `chainlink-ccip` hosts `chains/evm` and `chains/solana` in one repo
   with independent release tags (`solana-v1.6.2`). Same problem, same pattern.
2. DevRel already works here (`test.yml` has a `devrel-205/**` push trigger).
3. Docs and brand: `docs.chain.link/chainlink-local/build/ccip/{foundry,hardhat}`
   extends to `.../anchor` instead of forking the product name.
4. The two halves need each other: SVM→EVM outbound reuses
   `CCIPLocalRouter.routeMessage`, which is already public.
5. Version coupling is solved with a tag prefix, not a repo split.

The package is self-contained (no imports from the root package) so the decision
stays reversible: it can be lifted into its own repo in a day.

## Layout

```
src/ccip-svm/
  package.json               # @chainlink/local-solana
  src/
    core/                    # message DSL, artifact loader, surfpool lifecycle, token fixtures
    adapters/v1_6/           # OCR3 commit path
    adapters/v2_0/           # CCV path
    evm/                     # message conversion + handoff to CCIPLocalSimulator / Fork
    index.ts
  test/
  fixtures/                  # pinned program IDs, hashes, provenance (no binaries)
  examples/
.github/workflows/solana-test.yml    # paths: ['src/ccip-svm/**']
```

`forge` (`src = 'src'`, Compiles `.sol` only), Hardhat (`paths.sources: ./src`),
and the root npm `files` list (`src/**/*.sol`) all ignore non-Solidity content
under `src/`, so this is additive and does not affect the EVM package.

## Direction × mode matrix

| Direction | Local | Fork |
|---|---|---|
| EVM → SVM | Yes: real OffRamp + pools + receiver CPI, locally owned committee/CCVs | **Not possible.** The destination OffRamp only accepts Chainlink's committee/CCVs. |
| SVM → EVM | Yes: real SVM Router send → capture → EVM `CCIPLocalRouter.routeMessage` | Yes: real Router on a devnet fork → `CCIPLocalSimulatorFork` on the EVM side |

EVM→SVM "fork" is an experimental option only: clone devnet state, then
overwrite the forked OffRamp program/config locally. Real token state, fake
destination. Not a committed feature.

## Version matrix

|  | 1.6.2 | 2.0 |
|---|---|---|
| Status | Live on mainnet/devnet since May 2026 | Devnet now; mainnet Q4'26–Q1'27 |
| Artifacts | Tag `solana-v1.6.2`, sha256 pinned | Rolling `latest` prerelease + `executable-hashes.txt` |
| OffRamp ID | `offqSMQWgQud6WJz694LRzkeN5kMYpCHTpXQr3Rkcjm` | `off43sBHBsmWTU6VbfwKYCNwyJ4rSDhunYvz3QL7bF9` |
| Router ID | `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C` | same address, different binary |
| Inbound path | `commit` (OCR3, f=1) → `derive_accounts_execute` → `execute` | `resolve_accounts_*` → `execute_v2` with inline verifier results |
| Why keep it | Upgrade migrations and existing lanes | Every new lane lands here |

The two adapters cannot share one Surfpool instance: the router address is the
same but the binaries differ. One adapter per process.

## Architecture

Use the real programs. Simulate only the off-chain trust layer.

```
message DSL → encoded message (+ leaf/root for 1.6, verifier results for 2.0)
  → 2.0: resolve_accounts_* → execute_v2 → pool release/mint + receiver CPI
  → 1.6: commit (local OCR3) → derive_accounts_execute → execute → pool + receiver CPI
  → assert execution state, receiver state, SPL balances
```

Real: OffRamp, Router, FeeQuoter, RMNRemote, CommitteeVerifier, token pools,
receiver CPI, SPL transfers, execution states, production error codes.

Simulated: commit attestations, CCV signatures, RMN cursing, source-chain
finality, executor, fee quotes, lane config.

Rejected alternative: a mock OffRamp that only CPIs the receiver. It drifts,
cannot model token pools, and costs more to maintain than deploying the real
`.so` files.

## MVP

M0 spike (go/no-go), then:

- M1: shared core + 2.0 adapter, data-only `deliver()`, failure path, CI
- M2: 2.0 tokens (BurnMint, LockRelease), decimals conversion, token+data
- M3: 1.6 adapter behind the same API
- M4: SVM→EVM local (Router send → EVM `routeMessage`) + EVM→SVM handoff helper
- M5: SVM→EVM devnet fork via `CCIPLocalSimulatorFork` (nightly)

Non-goals: RMN cursing, real committee security, fee accuracy, finality/latency
semantics, CCTP, multi-validator, MEV, mainnet anything.

## API sketch

```ts
import { CcipSvmLocal } from "@chainlink/local-solana";

const sim = await CcipSvmLocal.start({ ccipVersion: "2.0" }); // or "1.6"
const receiver = await sim.deploy("./target/deploy/my_receiver.so");
await sim.receiver.setup(receiver, { sourceChain: "ethereum-sepolia" });

const res = await sim.deliver({
  sourceChain: "ethereum-sepolia",
  sender: "0xabc…",
  receiver,
  data: Buffer.from("hello"),
  tokens: [{ mint: usdc, amount: 1_000_000n }],
});
// → { messageId, sequenceNumber, executeSig, state: "Success" }
```

## Tooling and CI

- Node 22 floor, TypeScript.
- Surfpool pinned by exact release binary + checksum (or Docker tag). Never the
  `curl | bash` installer in CI: it always installs latest and Surfpool ships
  breaking cheatcode changes.
- `--no-tui --no-studio`, `online = false`. No network for the consumer.
- Program artifacts fetched once from the pinned release with sha256, cached.
- No Rust, no Anchor CLI, no Docker required from consumers.
- CI: `ubuntu-latest`, `paths: ['src/ccip-svm/**']`, 10 min timeout.

## Risks

1. Program/version drift: 1.6 → 2.0 invalidates encoders. Mitigated by adapter
   interface + pinned bundles + upstream release watcher.
2. 2.0 artifacts are a rolling prerelease. Pin a commit SHA and bump deliberately.
3. Old 1.6 `.so` on current Surfpool/LiteSVM is unverified. That is what M0 is for.
4. Fidelity illusion: local pass ≠ mainnet pass. Mitigated by an explicit
   "what is simulated" table and a `strictSignatures` mode.
5. Surfpool is third-party and fast-moving. Keep the validator behind an adapter
   so `solana-test-validator` works as a fallback.
6. Licensing: `chainlink-ccip` declares BUSL for some paths; `chains/solana` is
   not listed but the LICENSE is ambiguous. Do not bundle `.so` files in the npm
   tarball until legal confirms. Fetch-at-setup with pinned hashes is the default.
7. Ownership: DevRel owns it, CCIP Solana reviews. Needs a CODEOWNERS entry.

## Open decisions

1. 2.0 artifact pin: rolling `latest` vs commit SHA. Recommend SHA.
2. Licensing sign-off on redistributing artifacts.
3. Fork-mode expectations: confirm the team accepts "fork only for SVM→EVM".
4. Fidelity default: signatures off (fast) vs on (faithful).
