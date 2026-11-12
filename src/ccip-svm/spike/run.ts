/**
 * M0 spike: can we initialize the real CCIP 2.0 Solana programs on Surfpool
 * with a locally-owned upgrade authority, and drive an inbound message?
 *
 * Run: node spike/run.ts
 */
import fs from "node:fs";
import path from "node:path";
import anchor from "@anchor-lang/core";
import web3 from "@solana/web3.js";

const { AnchorProvider, Program, Wallet } = anchor;
const { Connection, Keypair, PublicKey, SystemProgram } = web3;
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CACHE = path.join(ROOT, ".ccip-svm-cache");
const RPC = "http://127.0.0.1:8899";

const IDS = {
  offramp: "off43sBHBsmWTU6VbfwKYCNwyJ4rSDhunYvz3QL7bF9",
  router: "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C",
  feeQuoter: "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi",
  rmnRemote: "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7",
  committeeVerifier: "CV2s8jsYhx9th8pyZ4pN7apLELAB42e5j4XqWhqTdWCm",
};

const SVM_CHAIN_SELECTOR = 16423721717087811551n; // Solana devnet

function idl(name) {
  return JSON.parse(fs.readFileSync(path.join(CACHE, `artifacts-2.0/target/idl/${name}.json`), "utf8"));
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(CACHE, "id.json"), "utf8"))),
);
const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(kp), {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});

function programData(programId) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(programId).toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

function pda(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0];
}

async function step(name, fn) {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`PASS ${name} (${Date.now() - t}ms)`, out ?? "");
    return out;
  } catch (e) {
    console.log(`FAIL ${name} (${Date.now() - t}ms)`);
    console.log(String(e).slice(0, 1200));
    throw e;
  }
}

const offrampIdl = idl("ccip_offramp");
const offramp = new Program(offrampIdl, provider);

console.log("wallet:", kp.publicKey.toBase58());

await step("airdrop 100 SOL", async () => {
  const sig = await connection.requestAirdrop(kp.publicKey, 100 * web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
});

await step("set upgrade authority on all programs", async () => {
  for (const id of Object.values(IDS)) {
    await rpc("surfnet_setProgramAuthority", [id, kp.publicKey.toBase58()]);
  }
});

await step("offramp.initialize", async () => {
  const offrampPk = new PublicKey(IDS.offramp);
  const referenceAddresses = pda([Buffer.from("reference_addresses")], IDS.offramp);
  const lookupTable = PublicKey.default; // stored only; real ALT wired later
  return offramp.methods
    .initialize()
    .accounts({
      referenceAddresses,
      router: new PublicKey(IDS.router),
      feeQuoter: new PublicKey(IDS.feeQuoter),
      rmnRemote: new PublicKey(IDS.rmnRemote),
      offrampLookupTable: lookupTable,
      authority: kp.publicKey,
      systemProgram: SystemProgram.programId,
      program: offrampPk,
      programData: programData(IDS.offramp),
    })
    .rpc();
});

await step("offramp.initializeConfig", async () => {
  const config = pda([Buffer.from("config")], IDS.offramp);
  return offramp.methods
    .initializeConfig(new anchor.BN(SVM_CHAIN_SELECTOR.toString()))
    .accounts({
      config,
      authority: kp.publicKey,
      systemProgram: SystemProgram.programId,
      program: new PublicKey(IDS.offramp),
      programData: programData(IDS.offramp),
    })
    .rpc();
});

console.log("\nM0 arm A step 2: PASS");
