# Canton spike

An experiment, not a product. It answers two questions: can `chainlink-local` run the real CCIP
Daml contracts on a local Canton participant, and can it deploy a complete trust layer there?

Yes to both. There is no `deliver()` yet.

## What works

Verified on macOS arm64, Canton 3.4.11:

```
$ node --test test/smoke/canton/delivery.test.js
[canton] 45 CCIP DARs from the pinned release
[canton] packages on ledger: 82, including CCIP.FactoryV2
[canton] DeployGlobalConfig: ok
[canton] DeployRMNRemote: ok
[canton] DeployTokenAdminRegistry: ok
[canton] DeployFeeQuoter: ok
[canton] DeployCommitteeVerifier: ok
[canton] DeployExecutor: ok
[canton] DeployOffRamp: ok
[canton] DeployOnRamp: ok
[canton] DeployPerPartyRouterFactory: ok
[canton] CreateRouter: ok
[canton] 9 CCIP contracts deployed
[canton] CCIPReceiver: 0005b3b1...
[canton] message id 0xb38f804fc7c56d93ef1a4a96e739347515cfe96c8f0712e347d20e6134bc8e9b
[canton] delivered: 0xb38f804f...

PASS: CCIP message executed on a local Canton participant.
```

So the smoke test deploys a complete CCIP instance, creates a per-party router and a receiver, then
delivers a message through the real `OffRamp`: `PrepareExecute`, a CCV verification, `Execute`.
A cold run takes about 60 seconds and exits clean.

`node --test test/unit/canton/codec.test.js` checks the message encoder byte for byte against the
Daml encoder in the released DAR.

## What is not built

- **Token transfers.** The pool templates ship and the factory can deploy them, but no pool is
  registered in the token admin registry and the inbound pool verification step is not wired.
- ~~Real committee signatures~~ Done: `committee.js` signs `keccak256(versionTag || messageId)` and
  the on-chain `CommitteeVerifier` checks ECDSA against configured signer keys.
- **The EVM half.** A `routeToCanton()` alongside the existing `routeToSvm()`.

## Toolchain facts

These cost time to find and are not in the tutorials:

| Thing | Reality |
|---|---|
| `dpm sandbox` | Only exists in the SDK binary, not in the bare `dpm` package manager. Run `dpm install 3.4.11` first. |
| `dpm sandbox --bootstrap` | Rejected: "bootstrap script cannot be defined together with the 'sandbox' command". Use repeated `--dar` for packages. |
| Ports | JSON API 6864, Ledger API gRPC 6865, admin 6866. `--canton-port-file <file>` writes them once ready. |
| Readiness | The sandbox prints "ready" *before* it finishes ingesting DARs. Poll `/v2/packages` for the package id you need. |
| Party allocation | `POST /v2/parties` with `{"partyIdHint": "alice"}`. No Daml tooling needed. |
| Command submission | `submit-and-wait-for-transaction` wraps everything in a `commands` key and returns the created events, which is how you get new contract ids. |
| Daml `Map` | Encodes as an array of two-element arrays, `[[key, value]]`. An empty map is `[]`. |
| Daml `Set` | Is a newtype over `Map`, so an empty set is `{"map": []}`. |
| Daml variants | `{"tag": "WaitForSafe", "value": {}}`. A nullary constructor still needs the `value` key. |
| `RawInstanceAddress` | Newtype over `Text` but encodes as `{"unpack": "<instanceId>@<party>"}`. |
| Template ids | `<packageId>:<Module>:<Entity>`, for example `...:CCIP.CoreV2.GlobalConfig:GlobalConfig`. |
| `AddCCVVerification` | Returns a new `ExecutingMessage` and archives the one passed in. Using the old contract id afterwards fails with `CONTRACT_NOT_FOUND`. |
| At least one CCV | The OffRamp refuses a message with no required CCV, so the lane must mandate one and the message must carry its verification. |
| `dpm` shutdown | `dpm` execs a JVM, so killing the launcher leaves Canton running. Spawn detached and signal the process group. |

## Why the factory matters

`CCIPFactory` is the upstream bootstrap API: one contract with a choice per CCIP component, and
each choice consumes the factory and returns a new one. That means the harness never hardcodes
contract construction, it just drives the same choices a production deployment drives.

The one catch: each choice takes the **fully built contract**, not a params record, so the harness
has to construct the same record the factory's own `mk*Contract` helpers would. Those field lists
are why `bootstrap.js` looks verbose.

## Files

- `artifacts.js` pins the release, verifies sha256, unpacks to `~/.cache/chainlink-local/canton`.
- `sandbox.js` starts and stops the daemon, wraps the JSON API, and encodes the small Daml types.
- `bootstrap.js` deploys the CCIP instance and creates the router.
- `committee.js` holds local signer keys and builds the verifierResults blob.
- `deliver.js` builds a message and calls `CCIPReceiver.Execute`, which runs the whole inbound path.

