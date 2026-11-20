# Canton spike

An experiment, not a product. It answers one question: can `chainlink-local` run the real CCIP
Daml contracts on a local Canton participant? So far: yes.

Nothing here simulates CCIP yet. There is no `deliver()` and no message codec. The point is to
de-risk the toolchain before anyone designs an API.

## What works

Verified on macOS arm64, Canton 3.4.11:

- The upstream release `contracts/v2.3.0` of `chainlink-canton` is pinned by sha256 and unpacked
  to a cache. It ships 45 prebuilt `.dar` files, so nothing is compiled locally.
- `dpm sandbox` runs a full single-process Canton with an in-memory ledger.
- All 45 DARs load into that sandbox, including `CCIP.CCIPReceiver`, `CCIP.CommitteeVerifierV2`,
  `CCIP.RuntimeV2` and the token pools.
- Parties are allocated and a `CCIP.CCIPReceiver` is created, over plain HTTP.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
node scripts/canton/probe.js
```

Expected: `PASS: real CCIP contracts live on a local Canton participant.`

## What is not built

- No CCIP trust layer bootstrap. `PerPartyRouter`, `CommitteeVerifierV2`, `FeeQuoter` and
  `RMNRemote` all need initialising before a message can execute, the way `bootstrap()` does for
  Solana in the `feat/svm-local` branch.
- No message construction. `MessageCodecV1.daml` defines the format on this side.
- No token pools wired to a registry.

## Toolchain facts

These cost time to find and are not in the tutorials:

| Thing | Reality |
|---|---|
| `dpm sandbox` | Only exists in the SDK binary, not in the bare `dpm` package manager. Run `dpm install 3.4.11` first. |
| `dpm sandbox --bootstrap` | Rejected: "bootstrap script cannot be defined together with the 'sandbox' command". Use repeated `--dar` for packages. |
| Ports | JSON API 6864, Ledger API gRPC 6865, admin 6866. `--canton-port-file <file>` writes them once ready. |
| Readiness | The sandbox prints "ready" *before* it finishes ingesting DARs. Poll `/v2/packages` for the package id you need. |
| Party allocation | `POST /v2/parties` with `{"partyIdHint": "alice"}`. No Daml tooling needed. |
| Command id | `POST /v2/commands/submit-and-wait` requires a `commandId` UUID, not just `commands`. |
| Daml variants | Encoded as `{"tag": "WaitForSafe", "value": {}}`. A nullary constructor still needs the `value` key, otherwise the ledger fails with `key not found: value`. |
| Default user | `participant_admin`, already present in a fresh sandbox. |
| Stopping it | `dpm` execs a JVM, so killing the launcher leaves Canton running. Spawn detached and signal the process group. |
| Ingest time | All 45 DARs settle at 82 registered packages, and it takes a few seconds after "ready" to get there. |

## Files

- `artifacts.js` pins the release, verifies sha256, unpacks to `~/.cache/chainlink-local/canton`.
- `sandbox.js` starts and stops the daemon and wraps the JSON API.
- `probe.js` is the runnable check above.
