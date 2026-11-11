/**
 * M0 spike: bootstrap the 2.0 trust layer locally.
 * Deploy -> init OffRamp -> init RMN -> init FeeQuoter -> init Router -> add_offramp
 *        -> init CommitteeVerifier -> chain config -> signer config -> add_source_chain
 */
import fs from "node:fs";
import path from "node:path";
import anchor from "@anchor-lang/core";
import web3 from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const { Connection, Keypair, PublicKey, SystemProgram } = web3;
const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CACHE = path.join(ROOT, ".ccip-svm-cache");
const RPC = "http://127.0.0.1:8899";
const ART = path.join(CACHE, "artifacts-2.0/target");

const IDS = {
  offramp: "off43sBHBsmWTU6VbfwKYCNwyJ4rSDhunYvz3QL7bF9",
  router: "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C",
  feeQuoter: "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi",
  rmnRemote: "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7",
  committeeVerifier: "CV2s8jsYhx9th8pyZ4pN7apLELAB42e5j4XqWhqTdWCm",
  receiverV2: "CbYiUaBi9nx1m3XhADWTdPoN25zeg5qDFBpbEfWKmrCL",
};

const SVM_CHAIN_SELECTOR = 16423721717087811551n;
const EVM_CHAIN_SELECTOR = 16015286601757825753n; // Ethereum Sepolia

const idl = (n) => JSON.parse(fs.readFileSync(path.join(ART, `idl/${n}.json`), "utf8"));
const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((x) => x.json());
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(CACHE, "id.json"), "utf8"))),
);
const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
const pda = (seeds, id) => PublicKey.findProgramAddressSync(seeds, new PublicKey(id))[0];
const programData = (id) => pda([new PublicKey(id).toBuffer()], BPF_LOADER);
const b = (s) => Buffer.from(s);

async function step(name, fn) {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`PASS ${name} (${Date.now() - t}ms)`, typeof out === "string" ? out : "");
  } catch (e) {
    console.log(`FAIL ${name} (${Date.now() - t}ms)\n${String(e).slice(0, 900)}`);
    throw e;
  }
}

const prog = Object.fromEntries(
  ["ccip_offramp", "ccip_router", "fee_quoter", "rmn_remote", "committee_verifier"].map((n) => [
    n,
    new Program(idl(n), provider),
  ]),
);
const offramp = prog.ccip_offramp;
const router = prog.ccip_router;
const feeQuoter = prog.fee_quoter;
const rmn = prog.rmn_remote;
const cv = prog.committee_verifier;

// --- local secp256k1 signer set -------------------------------------------
function ethAddress(priv) {
  const pub = secp256k1.getPublicKey(priv, false);
  return Buffer.from(keccak_256(pub.slice(1))).subarray(12);
}
const signers = Array.from({ length: 8 }, (_, i) => {
  const priv = keccak_256(Buffer.from(`chainlink-local-svm-signer-${i}`));
  return { priv, addr: ethAddress(priv) };
}).sort((a, b) => Buffer.compare(a.addr, b.addr));

console.log("wallet:", kp.publicKey.toBase58());
console.log("signers:", signers.map((s) => s.addr.toString("hex")).join(","));

await step("authority + airdrop", async () => {
  for (const id of Object.values(IDS)) await rpc("surfnet_setProgramAuthority", [id, kp.publicKey.toBase58()]);
  await rpc("requestAirdrop", [kp.publicKey.toBase58(), 100_000_000_000]);
});

await step("rmn.initialize", () =>
  rmn.methods
    .initialize()
    .accounts({
      config: pda([b("config")], IDS.rmnRemote),
      curses: pda([b("curses")], IDS.rmnRemote),
      authority: kp.publicKey,
      systemProgram: SystemProgram.programId,
      program: new PublicKey(IDS.rmnRemote),
      programData: programData(IDS.rmnRemote),
    })
    .rpc(),
);

const linkMint = Keypair.generate();
await step("create LINK stand-in mint", async () => {
  const { createMint } = await import("@solana/spl-token");
  await createMint(connection, kp, kp.publicKey, null, 6, linkMint);
  return linkMint.publicKey.toBase58();
});

await step("feeQuoter.initialize", () =>
  feeQuoter.methods
    .initialize(new BN("1000000000000000000"), new PublicKey(IDS.router))
    .accounts({
      config: pda([b("config")], IDS.feeQuoter),
      linkTokenMint: linkMint.publicKey,
      authority: kp.publicKey,
      systemProgram: SystemProgram.programId,
      program: new PublicKey(IDS.feeQuoter),
      programData: programData(IDS.feeQuoter),
    })
    .rpc(),
);

await step("router.initialize", () =>
  router.methods
    .initialize(
      new BN(SVM_CHAIN_SELECTOR.toString()),
      kp.publicKey,
      new PublicKey(IDS.feeQuoter),
      new PublicKey(IDS.offramp),
      new PublicKey(IDS.rmnRemote),
    )
    .accounts({
      config: pda([b("config")], IDS.router),
      authority: kp.publicKey,
      systemProgram: SystemProgram.programId,
      program: new PublicKey(IDS.router),
      programData: programData(IDS.router),
    })
    .rpc(),
);

await step("router.addOfframp (creates allowed_offramp PDA)", () =>
  router.methods
    .addOfframp(new BN(EVM_CHAIN_SELECTOR.toString()), new PublicKey(IDS.offramp))
    .accounts({
      config: pda([b("config")], IDS.router),
      authority: kp.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc(),
);

await step("committeeVerifier.initialize", () =>
  cv.methods
    .initialize()
    .accounts({
      config: pda([b("config")], IDS.committeeVerifier),
      storageLocations: pda([b("storage_locations")], IDS.committeeVerifier),
      authority: kp.publicKey,
      systemProgram: SystemProgram.programId,
      program: new PublicKey(IDS.committeeVerifier),
      programData: programData(IDS.committeeVerifier),
    })
    .rpc(),
);

await step("committeeVerifier.initChainConfig", () =>
  cv.methods
    .initChainConfig({
      remoteChainSelector: new BN(EVM_CHAIN_SELECTOR.toString()),
      chainConfig: {
        routerSigner: pda([b("ccv_signer")], IDS.router),
        fee: 0,
        gasForVerification: 500_000,
        payloadSizeBytes: 390,
      },
    })
    .accounts({
      config: pda([b("config")], IDS.committeeVerifier),
      authority: kp.publicKey,
      remoteChainConfig: pda(
        [b("remote_chain"), Buffer.from(new BN(EVM_CHAIN_SELECTOR.toString()).toArray("le", 8))],
        IDS.committeeVerifier,
      ),
      systemProgram: SystemProgram.programId,
    })
    .rpc(),
);

await step("committeeVerifier.setSignerConfig", () =>
  cv.methods
    .setSignerConfig({
      sourceChainSelector: new BN(EVM_CHAIN_SELECTOR.toString()),
      threshold: 1,
      signers: signers.slice(0, 4).map((s) => Array.from(s.addr)),
    })
    .accounts({
      config: pda([b("config")], IDS.committeeVerifier),
      authority: kp.publicKey,
      remoteChainConfig: pda(
        [b("remote_chain"), Buffer.from(new BN(EVM_CHAIN_SELECTOR.toString()).toArray("le", 8))],
        IDS.committeeVerifier,
      ),
      systemProgram: SystemProgram.programId,
    })
    .rpc(),
);

await step("offramp.addSourceChain", () =>
  offramp.methods
    .addSourceChain({
      newChainSelector: new BN(EVM_CHAIN_SELECTOR.toString()),
      sourceChainConfig: {
        isEnabled: true,
        onRamps: [
          {
            bytes: Array.from(Buffer.alloc(64, 1)),
            len: 20,
          },
        ],
        defaultCcvs: [new PublicKey(IDS.committeeVerifier)],
        laneMandatedCcvs: [],
        legacyAddressLength: 20,
      },
    })
    .accounts({
      sourceChain: pda(
        [b("source_chain_state"), Buffer.from(new BN(EVM_CHAIN_SELECTOR.toString()).toArray("le", 8))],
        IDS.offramp,
      ),
      config: pda([b("config")], IDS.offramp),
      authority: kp.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc(),
);

console.log("\nM0 arm A step 3: PASS (trust layer locally owned)");
