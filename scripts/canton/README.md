# Canton adapter

Runs the real CCIP 2.0 Daml contracts on a local Canton participant, so an app can be tested against
a real `OffRamp` instead of a mock.

## Quick start

```js
import { startCantonLocal } from "@chainlink/local/canton";

const canton = await startCantonLocal();

// Inbound: a message from another chain, through the real OffRamp and the local committee.
const result = await canton.deliver({ data: "68656c6c6f" });

// Inbound with tokens: the pool releases a ticket and a holding is created.
const withTokens = await canton.deliver({ token: { amount: 7n * 10n ** 10n } });

// Outbound: opens the destination lane on first use, returns the encoded CCIP message.
const sent = await canton.send({ receiver: `0x${"00".repeat(12)}${"44".repeat(20)}`, payload: "68656c6c6f" });

// Outbound with tokens: the pool burns the sender's holding before the send.
const sentTokens = await canton.send({ receiver: `0x${"00".repeat(12)}${"44".repeat(20)}`, token: { amount: "7.0" } });

// Outbound plus the struct the EVM router takes.
const { evmMessage } = await canton.routeToCanton({ payload: "68656c6c6f" });

await canton.stop();
```

Each `deliver` and `send` returns the next router id internally, because both choices consume it.

## What is real

- The participant, the ledger, and the CCIP contracts: 45 prebuilt DARs from the pinned upstream
  release, deployed through the upstream `CCIPFactory`.
- The message encoding, checked byte for byte against `CCIP.CodecV2.MessageCodecV1`.
- Committee signatures: the verifier checks real ECDSA over `keccak256(versionTag || messageId)`.
- The token: LINK as a Splice instrument with holdings, a burn/mint pool, three rate limiters, and
  the registry handshake.

## What is simulated

The offchain trust layer. A local party owns the instance, lanes use made-up addresses, and the
committee keys are local. No fork mode: a real `OffRamp` only accepts Chainlink's own committee, so
there is no key to sign an inbound fork message with.

## What is not done

- Handing a message to a live EVM node. `routeToCanton()` produces the struct; the call itself is
  the caller's.

## Requirements

Node 22, JDK 17 and the Daml SDK, because the sandbox is the SDK's daemon:

```bash
brew install openjdk@17
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
dpm install 3.4.11
```

The first run downloads the release (51 MB) into `~/.cache/chainlink-local/canton`.

## Tests

```bash
npm run test:canton
```

Unit tests are seconds; the two smoke tests each boot a sandbox and take about a minute.

## Notes from the wire

| Thing | Reality |
|---|---|
| `dpm sandbox` | Only in the SDK binary, not the bare `dpm`. `dpm install 3.4.11` first. |
| `--bootstrap` | Rejected with `sandbox`; use repeated `--dar`. |
| Readiness | Ready is printed before DAR ingestion finishes; poll `/v2/packages`. |
| Daml `Map` | Array of `[key, value]` pairs. Empty is `[]`. |
| Daml `Set` | `{"map": []}`. |
| All-nullary enums | Plain strings. Only constructors with arguments use `{tag, value}`. |
| `RawInstanceAddress` | `{"unpack": "<id>@<party>"}`. |
| `AddCCVVerification` | Returns a new `ExecutingMessage` and archives the input. |
| `Execute` / `CCIPSend` | Both consume the router; the returned id is the next one. |
| Token amounts | CCIP uses base units; the Daml side uses whole tokens at 10 decimals. |
| Ordering in a send | `CalculateFee` only while `Prepared`; `ForwardToVerifier` only after `FinalizeFee`. |

## Why plain JavaScript

The SVM adapter is TypeScript with a build step. This one is `.js` and runs directly on Node 22,
the same way `scripts/CCIPLocalSimulatorFork.js` does. The trade-off is that it ships no type
declarations; porting to TypeScript is a mechanical change if the package standardises on it.

## Files

- `index.js` public entry, `startCantonLocal`
- `artifacts.js` pinned release, sha256, cache
- `sandbox.js` daemon lifecycle and the JSON Ledger API client
- `bootstrap.js` deploy the CCIP instance through `CCIPFactory`
- `codec.js` message and token transfer encoding
- `committee.js` local signer keys and the verifier results blob
- `deliver.js` inbound, one `CCIPReceiver.Execute` call
- `lane.js` outbound destination lane, fee config and prices
- `send.js` mint the fee holding and walk `PrepareSend` to `CCIPSend`
- `evm.js` convert a sent message to the EVM router struct
