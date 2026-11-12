/**
 * M0 spike: deliver an EVM-originated CCIP 2.0 message into a Solana receiver,
 * using the real OffRamp, Router, RMN and CommitteeVerifier on Surfpool.
 */
import fs from "node:fs";
import path from "node:path";
import anchor from "@anchor-lang/core";
import web3 from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { SigningKey } from "ethers";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } = web3;
const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CACHE = path.join(ROOT, ".ccip-svm-cache");
const ART = path.join(CACHE, "artifacts-2.0/target");
const RPC = "http://127.0.0.1:8899";

const IDS = {
  offramp: "off43sBHBsmWTU6VbfwKYCNwyJ4rSDhunYvz3QL7bF9",
  router: "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C",
  feeQuoter: "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi",
  rmnRemote: "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7",
  committeeVerifier: "CV2s8jsYhx9th8pyZ4pN7apLELAB42e5j4XqWhqTdWCm",
  receiver: "GsgXbSfG226vCVMfamUhwFgY4kF9HkNiu3wk8Ho8cky5",
};

const SVM_CHAIN_SELECTOR = 16423721717087811551n;
const EVM_CHAIN_SELECTOR = 16015286601757825753n;
const CV_VERSION_TAG = Buffer.from([0xe9, 0xa0, 0x5a, 0x20]);

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

// ---- borsh helpers -------------------------------------------------------
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const vecU8 = (buf) => Buffer.concat([u32(buf.length), buf]);
const vecVecU8 = (arr) => Buffer.concat([u32(arr.length), ...arr.map(vecU8)]);
const vecPubkey = (keys) => Buffer.concat([u32(keys.length), ...keys.map((k) => k.toBuffer())]);
const some = (buf) => Buffer.concat([Buffer.from([1]), buf]);
const none = () => Buffer.from([0]);

const disc = (idlObj, name) => Buffer.from(idlObj.instructions.find((i) => i.name === name).discriminator);

// ---- message codec (custom, NOT borsh) -----------------------------------
function encodeMessage(m) {
  const parts = [
    Buffer.from([1]),
    beU64(m.sourceChainSelector),
    beU64(m.destChainSelector),
    beU64(m.messageNumber),
    beU32(m.executionGasLimit),
    beU32(m.ccipReceiveGasLimit),
    beU16(m.finalityFlags ?? 0),
    beU16(m.finalityBlockDepth ?? 0),
    m.ccvAndExecutorHash,
    lenU8(m.onRampAddress),
    lenU8(m.offRampAddress),
    lenU8(m.sender),
    lenU8(m.receiver),
    lenU16(m.destBlob),
    m.tokenTransfer ? lenU16(m.tokenTransfer) : lenU16(Buffer.alloc(0)),
    lenU16(m.data),
  ];
  return Buffer.concat(parts);
}
const beU64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const beU32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const beU16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const lenU8 = (buf) => Buffer.concat([Buffer.from([buf.length]), buf]);
const lenU16 = (buf) => { const b = Buffer.alloc(2); b.writeUInt16BE(buf.length); return Buffer.concat([b, buf]); };

// ---- verifier results ----------------------------------------------------
function ethAddress(priv) {
  const pub = secp256k1.getPublicKey(priv, false);
  return Buffer.from(keccak_256(pub.slice(1))).subarray(12);
}
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function signVerifierResults(messageId, candidates, threshold) {
  const signedHash = Buffer.from(keccak_256(Buffer.concat([CV_VERSION_TAG, messageId])));
  const sigs = [];
  for (const cand of candidates) {
    if (sigs.length === threshold) break;
    const sk = new SigningKey("0x" + Buffer.from(cand.priv).toString("hex"));
    const sig = sk.sign("0x" + signedHash.toString("hex"));
    let sv = BigInt(sig.s);
    if (sig.v === 28) sv = N - sv; // normalize to recovery id 0, as the Go client does
    sigs.push(Buffer.concat([
      Buffer.from(sig.r.slice(2), "hex"),
      Buffer.from(sv.toString(16).padStart(64, "0"), "hex"),
    ]));
  }
  if (sigs.length < threshold) throw new Error("no signer with recovery id 0");
  const body = Buffer.concat(sigs);
  const out = Buffer.alloc(6 + body.length);
  CV_VERSION_TAG.copy(out, 0);
  out.writeUInt16BE(body.length, 4);
  body.copy(out, 6);
  return out;
}

// ---- main ----------------------------------------------------------------
const offrampIdl = idl("ccip_offramp");
const offramp = new Program(offrampIdl, provider);
const receiverProg = new Program(idl("test_ccip_receiver"), provider);

const log = (...a) => console.log(...a);

async function call(name, fn) {
  const t = Date.now();
  try {
    const r = await fn();
    log(`PASS ${name} (${Date.now() - t}ms)`);
    return r;
  } catch (e) {
    log(`FAIL ${name} (${Date.now() - t}ms)`);
    log(String(e.message ?? e));
    if (e.logs) log(e.logs.join("\n"));
    throw e;
  }
}

// 1. receiver init
const receiverAuthority = kp.publicKey;
const counterPda = pda([Buffer.from("counter")], IDS.receiver);
const extExecCfgPda = pda([Buffer.from("external_execution_config")], IDS.receiver);
const allowedOfframpPda = pda(
  [Buffer.from("allowed_offramp"), Buffer.from(new BN(EVM_CHAIN_SELECTOR.toString()).toArray("le", 8)), new PublicKey(IDS.offramp).toBuffer()],
  IDS.router,
);

const existing = await connection.getAccountInfo(counterPda);
if (!existing) {
  await call("receiver.initialize", () =>
    receiverProg.methods
      .initialize(new PublicKey(IDS.router))
      .accounts({
        counter: counterPda,
        externalExecutionConfig: extExecCfgPda,
        authority: receiverAuthority,
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
  );
} else {
  log("SKIP receiver.initialize (already initialized)");
}

const allowedInfo = await connection.getAccountInfo(allowedOfframpPda);
log("allowed_offramp exists:", allowedOfframpPda.toBase58(), !!allowedInfo, "owner:", allowedInfo?.owner.toBase58());

// 2. build message
const sender = Buffer.alloc(20, 2);
const onRamp = Buffer.alloc(20, 1);
const destBlob = Buffer.concat([
  Buffer.from([0x1a, 0x2b, 0x3c, 0x4d]),
  Buffer.from([0]), // use_ata
  (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(0b11n); return b; })(),
  Buffer.from([3]),
  extExecCfgPda.toBuffer(),
  counterPda.toBuffer(),
  SystemProgram.programId.toBuffer(),
]);

const data = Buffer.from(JSON.stringify({ hello: "from-ethereum" }));
const msg = encodeMessage({
  sourceChainSelector: EVM_CHAIN_SELECTOR,
  destChainSelector: SVM_CHAIN_SELECTOR,
  messageNumber: 1n,
  executionGasLimit: 200_000,
  ccipReceiveGasLimit: 200_000,
  ccvAndExecutorHash: Buffer.alloc(32),
  onRampAddress: onRamp,
  offRampAddress: new PublicKey(IDS.offramp).toBuffer(),
  sender,
  receiver: new PublicKey(IDS.receiver).toBuffer(),
  destBlob,
  tokenTransfer: null,
  data,
});
const messageId = Buffer.from(keccak_256(msg));
log("messageId:", messageId.toString("hex"), "len:", msg.length);

// 3. verifier results
const allSigners = Array.from({ length: 8 }, (_, i) => {
  const priv = keccak_256(Buffer.from(`chainlink-local-svm-signer-${i}`));
  return { priv, addr: ethAddress(priv) };
}).sort((a, b) => Buffer.compare(a.addr, b.addr));
const verifierResults = signVerifierResults(messageId, allSigners, 1);
console.log("verifier results built from key pool of", allSigners.length);
log("verifierResults:", verifierResults.toString("hex").slice(0, 40), "...");

// 4. execute_v2 params
const execIxName = "execute_v2";
const ixDisc = disc(offrampIdl, execIxName);
const encodeExecuteParams = (metadata) =>
  Buffer.from(
    offramp.coder.instruction.encode("executeV2", {
      params: {
        execInputs: {
          encodedMessage: msg,
          ccvs: [new PublicKey(IDS.committeeVerifier)],
          verifierResults: [verifierResults],
        },
        resolutionMetadata: metadata,
      },
    }),
  );
let ixData = encodeExecuteParams(Buffer.alloc(0));
console.log("ixData:", ixData.toString("hex").slice(0, 80), "len", ixData.length);

// 4b. direct verifier check (isolates the signature from the OffRamp)
try {
  const cvProg = new Program(idl("committee_verifier"), provider);
  const cvCfg = pda([Buffer.from("config")], IDS.committeeVerifier);
  const cvRemote = pda(
    [Buffer.from("remote_chain"), Buffer.from(new BN(EVM_CHAIN_SELECTOR.toString()).toArray("le", 8))],
    IDS.committeeVerifier,
  );
  const dsig = await cvProg.methods
    .verify({
      messageId: Array.from(messageId),
      encodedMessage: msg,
      verifierResults,
    })
    .accounts({ config: cvCfg, remoteChainConfig: cvRemote })
    .rpc();
  log("DIRECT VERIFY PASS", dsig);
} catch (e) {
  log("DIRECT VERIFY FAIL", String(e.message).slice(0, 300));
  if (e.logs) log(e.logs.join("\n"));
}

// 5. resolve
const configPda = pda([Buffer.from("config")], IDS.offramp);
const startDisc = disc(offrampIdl, "resolve_accounts_start");
const stageByName = Object.fromEntries(
  offrampIdl.instructions.map((i) => [Buffer.from(i.discriminator).toString("hex"), i.name]),
);

function buildResolveIx(discriminator, metadata, accounts) {
  const params = Buffer.concat([
    kp.publicKey.toBuffer(),
    vecU8(ixData),
    vecU8(metadata),
  ]);
  return new TransactionInstruction({
    programId: new PublicKey(IDS.offramp),
    keys: accounts.map((k) => ({ pubkey: k, isSigner: false, isWritable: false })),
    data: Buffer.concat([discriminator, params]),
  });
}

async function simulate(ix) {
  const tx = new Transaction().add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(kp);
  const res = await connection.simulateTransaction(tx);
  if (res.value.err) throw new Error(`sim err: ${JSON.stringify(res.value.err)}\n${(res.value.logs || []).join("\n")}`);
  const prefix = `Program return: ${IDS.offramp} `;
  const line = (res.value.logs || []).find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`no return data:\n${(res.value.logs || []).join("\n")}`);
  return Buffer.from(line.slice(prefix.length), "base64");
}

function decodeResponse(buf) {
  let o = 0;
  const rdU32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const rdPubkey = () => { const k = new PublicKey(buf.subarray(o, o + 32)); o += 32; return k; };
  const askN = rdU32();
  const askAgain = Array.from({ length: askN }, rdPubkey);
  const accN = rdU32();
  const accountsToSave = [];
  for (let i = 0; i < accN; i++) {
    const pubkey = rdPubkey();
    const isSigner = buf[o++] === 1;
    const isWritable = buf[o++] === 1;
    accountsToSave.push({ pubkey, isSigner, isWritable });
  }
  const lutN = rdU32();
  const luts = Array.from({ length: lutN }, rdPubkey);
  const hasNext = buf[o++];
  const nextDisc = hasNext ? Buffer.from(buf.subarray(o, (o += 8))) : null;
  const metaLen = rdU32();
  const metadata = Buffer.from(buf.subarray(o, o + metaLen));
  return { askAgain, accountsToSave, luts, nextDisc, metadata };
}

const accounts = [];
const result = await call("resolve accounts", async () => {
  let discriminator = startDisc;
  let metadata = Buffer.alloc(0);
  let accountKeys = [configPda];
  for (let round = 0; round < 32; round++) {
    const raw = await simulate(buildResolveIx(discriminator, metadata, accountKeys));
    const resp = decodeResponse(raw);
    accounts.push(...resp.accountsToSave);
    log(
      `  round ${round}: stage=${stageByName[discriminator.toString("hex")]} save=${resp.accountsToSave.length} ask=${resp.askAgain.length} next=${resp.nextDisc ? stageByName[resp.nextDisc.toString("hex")] : "done"}`,
    );
    if (!resp.nextDisc) return resp;
    discriminator = resp.nextDisc;
    metadata = resp.metadata;
    accountKeys = resp.askAgain;
  }
  throw new Error("resolution exceeded rounds");
});

log("metadata len:", result.metadata.length, "program message_id:", result.metadata.subarray(result.metadata.length - 32).toString("hex"));
log("local    message_id:", messageId.toString("hex"));
ixData = encodeExecuteParams(result.metadata);

log(`\nresolved ${accounts.length} accounts:`);
accounts.forEach((a, i) => log(`  ${i} ${a.pubkey.toBase58()} signer=${a.isSigner} writable=${a.isWritable}`));

// 6. execute via an address lookup table (production uses the same mechanism)
const executeIx = new TransactionInstruction({
  programId: new PublicKey(IDS.offramp),
  keys: accounts.map((a) => ({ pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable })),
  data: ixData,
});

const { AddressLookupTableProgram, TransactionMessage, VersionedTransaction } = web3;
const slot = await connection.getSlot();
const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
  authority: kp.publicKey,
  payer: kp.publicKey,
  recentSlot: slot,
});
const extendIx = AddressLookupTableProgram.extendLookupTable({
  lookupTable: altAddress,
  authority: kp.publicKey,
  payer: kp.publicKey,
  addresses: accounts.map((a) => a.pubkey),
});
const setupTx = new Transaction().add(createIx, extendIx);
setupTx.feePayer = kp.publicKey;
setupTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
setupTx.sign(kp);
await connection.sendRawTransaction(setupTx.serialize(), { skipPreflight: false });
await rpc("surfnet_timeTravel", [{ absoluteSlot: slot + 10 }]);

const alt = (await connection.getAddressLookupTable(altAddress)).value;
const msgV0 = new TransactionMessage({
  payerKey: kp.publicKey,
  recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
  instructions: [executeIx],
}).compileToV0Message([alt]);
const vtx = new VersionedTransaction(msgV0);
vtx.sign([kp]);
const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
const conf = await connection.confirmTransaction(sig, "confirmed");
log("\nexecute sig:", sig, "err:", conf.value.err);

// 7. assert
const counterAfter = await connection.getAccountInfo(counterPda);
log("counter account:", counterAfter ? "present" : "missing");
const txInfo = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
log((txInfo?.meta?.logMessages || []).slice(-25).join("\n"));
