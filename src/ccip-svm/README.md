# @chainlink/local-solana

Local CCIP 2.0 simulator for Solana. Boots [Surfpool](https://surfpool.run), deploys the real
CCIP Solana programs, and delivers EVM-originated messages into your receiver without waiting
for source-chain finality.

```ts
import { CcipSvmLocal } from "@chainlink/local-solana";

const sim = await CcipSvmLocal.start();

// data-only
await sim.deliver({ data: "hello from ethereum" });

// token transfer
const { mint } = await sim.createBurnMintToken();
await sim.deliver({ data: "tokens", token: { mint, amount: 7n } });
await sim.connection.getTokenAccountBalance(sim.tokenAccountFor(mint));

// outbound: a real Router send on the local EVM lane
const sent = await sim.send({ receiver: Buffer.alloc(20, 0xab), data: "hello evm" });

await sim.stop();
```

## What runs for real

- OffRamp, Router, FeeQuoter, RMNRemote and CommitteeVerifier programs
- account resolution (`resolve_accounts_*`), exactly as the production executor drives it
- the CCV verification CPI, with a locally owned committee
- the receiver `ccip_receive` CPI

## What is simulated

- commit attestations and CCV signatures (signed by locally generated keys)
- RMN cursing, source-chain finality, the executor, fee quotes and lane configuration

Passing locally is not a substitute for a testnet run. Everything outside this list is real.

## Requirements

- Node 22+
- `surfpool` on `PATH` (or `SURFPOOL_BIN=/path/to/surfpool`). The harness runs it with
  `--offline --no-deploy --no-tui --no-studio --ci`, so no datasource and no TUI.

Program artifacts are downloaded once from the pinned `chainlink-ccip-solana` release and
verified against a SHA-256 digest. Set `CCIP_SVM_ARTIFACTS=/path/to/extracted` to use a local
bundle instead.

## API

```ts
CcipSvmLocal.start(opts?): Promise<CcipSvmLocal>
CcipSvmLocal.deliver({ data, sourceChainSelector?, sender?, receiverProgram?, receiverAccounts? })
  : Promise<{ messageId, signature, resolutionTrace }>
CcipSvmLocal.receiverCounterValue(): Promise<bigint>
CcipSvmLocal.stop(): Promise<void>
```

`start()` accepts `surfpoolUrl` to attach to an existing instance instead of spawning one.

## Scope

This slice targets **EVM ↔ SVM** in local mode, with arbitrary data and BurnMint token transfers
inbound and a real Router send outbound; pair `send()` with `deliverToEvm()` to complete the
outbound direction against any EVM node. Forked networks are not implemented. Fork mode for the
inbound direction is not possible in principle: a real OffRamp only accepts Chainlink's own
committee and CCVs.

See [`../../PLAN.md`](../../PLAN.md) for the decision, progress, backlog and the hard-won
implementation facts.
