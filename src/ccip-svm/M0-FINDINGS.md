# M0 findings — CCIP SVM on Surfpool

Date: 2026-11-11
Branch: `feat/svm-local`
Environment: macOS arm64, Node 24.14, Surfpool 1.7.0 (pinned release binary),
CCIP 2.0 Solana artifacts from `chainlink-ccip-solana` release `latest`
(rolling prerelease, fetched 2026-11-11).

**Verdict: GO for 2.0. The core assumption holds — the real programs run on
Surfpool and a local key can own the entire trust layer.**

## What was proven

| Step | Result | Time |
|---|---|---|
| Deploy 6 programs via `surfnet_writeProgram` | PASS — all `executable=true`, owner `BPFLoaderUpgradeab1e…` | 68–104 ms |
| Take program upgrade authority locally (`surfnet_setProgramAuthority`) | PASS | 23 ms |
| `offramp.initialize` (admin-gated on upgrade authority) | PASS | 238 ms |
| `offramp.initialize_config` | PASS | 267 ms |
| `rmn_remote.initialize` | PASS | 229 ms |
| create LINK stand-in SPL mint | PASS | 259 ms |
| `fee_quoter.initialize` | PASS | 265 ms |
| `ccip_router.initialize` | PASS | 214 ms |
| `router.add_offramp` (creates router-owned `allowed_offramp` PDA) | PASS | 273 ms |
| `committee_verifier.initialize` | PASS | 276 ms |
| `committee_verifier.init_chain_config` | PASS | 235 ms |
| `committee_verifier.set_signer_config` (threshold 1, 4 local signers) | PASS | 228 ms |
| `offramp.add_source_chain` (with our CCV as `default_ccvs`) | PASS | 274 ms |

Total bootstrap after program deploy: ~2.5 s. No Docker, no Rust, no Anchor CLI,
no network.

Scripts: `spike/run.ts` (deploy prerequisites + offramp init),
`spike/bootstrap.ts` (trust layer), `spike/addsource.ts` (debug helper).
Program deploy is in `.ccip-svm-cache/probe.mjs`.

## Findings that change the implementation plan

### 1. `surfnet_writeProgram` is the deployment mechanism

It writes a ProgramData account with **no upgrade authority**, and the 2.0
programs gate `initialize` on
`program_data.upgrade_authority_address == Some(authority)`. So the harness must
call `surfnet_setProgramAuthority(programId, localKey)` before any init. One
RPC per program, ~4 ms each.

### 2. The 2.0 message wire format is NOT Borsh

This is the single most important finding. `MessageV1::to_bytes` is a custom
versioned big-endian codec:

```
u8   version (= 1)
u64  source_chain_selector      BE
u64  dest_chain_selector        BE
u64  message_number             BE
u32  execution_gas_limit        BE
u32  ccip_receive_gas_limit     BE
u16  finality.flags             BE
u16  finality.block_depth       BE
[32] ccv_and_executor_hash
u8-len  on_ramp_address
u8-len  off_ramp_address
u8-len  sender
u8-len  receiver
u16-len dest_blob
u16-len token_transfer (0 = none)
u16-len data
```

`message_id = keccak256(those bytes)`. A Borsh encoder would produce a valid-
looking message with the wrong ID and fail deep inside `execute_v2`. The TS
encoder must mirror this exactly, and the 1.6 encoder must be checked against
`HashAny2SVMMessage` separately (it is a different scheme).

### 3. The CommitteeVerifier is locally ownable, with one wrinkle

`verifier_results` wire format: `u8[4] version_tag | u16 BE sig_byte_len |
N × 64-byte signatures`.

- `version_tag` is hardcoded `[0xe9, 0xa0, 0x5a, 0x20]`
  (`bytes4(keccak256("CommitteeVerifier 2.0.0"))`).
- signed hash = `keccak(version_tag || message_id)`.
- signatures must be **strictly ascending by recovered ETH address**.
- the on-chain verifier always recovers with `recovery_id = 0` and rejects
  high-s.

Consequence: **not every key is usable for every message.** A key whose
signature over a given hash naturally recovers with parity 1 cannot be used at
all. The harness must keep a pool of keys (e.g. 8–16), and for each message
select `threshold` keys whose signature recovers with parity 0, then sort by
address. This is cheap off-chain but must be in the design, not discovered
later.

### 4. Account resolution is optional for execution

`execute_v2` takes `resolution_metadata` = Borsh
`{ account_list_lengths: OfframpAccountListLengths, message_id: [u8;32] }`.
The program uses it to lay out `remaining_accounts`. The staged
`resolve_accounts_*` instructions exist to compute that layout, but are not
required if the client can build it itself.

Two viable paths:

- **A. Drive the resolver** (version-proof, matches the real executor, more
  client work: a multi-call simulation loop).
- **B. Build the layout locally** (faster, but re-implements per-version
  knowledge — the exact drift risk we wanted to avoid).

Recommendation: implement A once in the shared core, use B only as a debug
fallback. The resolver is the main remaining M1 work item.

### 5. The receiver needs a router-owned allowlist PDA

`execute_v2` passes a fixed `allowed_offramp` account into the receiver CPI.
It is created by `router.add_offramp(sourceChainSelector, offramp)` and owned by
the router. So the bootstrap always needs Router + FeeQuoter + RMN, even for
inbound-only data messages. That is already covered above.

### 6. Program IDs

2.0 and 1.6 share `ccip_router` (`Ccip842…`) but have different OffRamps
(`off43sBHB…` vs `offqSMQ…`). The binaries differ, so **one adapter per
Surfpool instance**; a test needing both must run two validators.

## Not done yet

1. **`execute_v2` end to end.** Blocked on the account-layout work above. This
   is the last unknown in the inbound path.
2. **1.6 arm.** Not attempted. Its trust layer is OCR3 (secp256k1 committee,
   `f = 1`, two signatures over `keccak(report_bytes || report_context)`), which
   is a different but comparable amount of work. The 1.6 artifacts deploy the
   same way; only the bootstrap differs.
3. **Token pools.** Untouched in both versions.
4. **SVM→EVM.** Untouched.

## Revised estimate

- 2.0 inbound data-only, complete: **+3–5 days** (resolver + message codec +
  receiver wiring).
- 1.6 inbound data-only: **+3–4 days** after the core exists.
- The trust-layer risk is retired; remaining risk is ordinary implementation.
