import fs from "node:fs";
import path from "node:path";
import anchor from "@anchor-lang/core";
import web3 from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const ROOT = path.resolve(import.meta.dirname, "../../..");
const CACHE = path.join(ROOT, ".ccip-svm-cache");
const idl = JSON.parse(fs.readFileSync(path.join(CACHE, "artifacts-2.0/target/idl/committee_verifier.json"), "utf8"));
const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(CACHE, "id.json"), "utf8"))));
const provider = new AnchorProvider(new web3.Connection("http://127.0.0.1:8899", "confirmed"), new Wallet(kp), { commitment: "confirmed" });
const cv = new Program(idl, provider);

const EVM = 16015286601757825753n;
const sel = Buffer.from(new BN(EVM.toString()).toArray("le", 8));
const cfgPda = web3.PublicKey.findProgramAddressSync([Buffer.from("remote_chain"), sel], new web3.PublicKey("CV2s8jsYhx9th8pyZ4pN7apLELAB42e5j4XqWhqTdWCm"))[0];
const cfg = await cv.account.remoteChainConfig.fetch(cfgPda);
console.log("cfg keys:", Object.keys(cfg));
console.log("threshold:", cfg.signerConfig?.threshold ?? cfg.signer_config?.threshold);
const signers = cfg.signerConfig?.signers ?? cfg.signer_config?.signers;
console.log("signers:", signers.map((s) => Buffer.from(s).toString("hex")));

function ethAddress(priv) {
  const pub = secp256k1.getPublicKey(priv, false);
  return Buffer.from(keccak_256(pub.slice(1))).subarray(12);
}

const all = Array.from({ length: 8 }, (_, i) => {
  const priv = keccak_256(Buffer.from(`chainlink-local-svm-signer-${i}`));
  return { priv, addr: ethAddress(priv) };
}).sort((a, b) => Buffer.compare(a.addr, b.addr));
console.log("local signers:", all.map((s) => s.addr.toString("hex")));

// verify recovery for a sample hash
const msgId = Buffer.alloc(32, 7);
const hash = Buffer.from(keccak_256(Buffer.concat([Buffer.from([0xe9, 0xa0, 0x5a, 0x20]), msgId])));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
for (const lowS of [true, false]) {
  for (const s of all.slice(0, 2)) {
    const sig = secp256k1.sign(hash, s.priv, { lowS, format: "recovered" });
    const rec = sig[0];
    const r = Buffer.from(sig.subarray(1, 33));
    let sv = BigInt("0x" + Buffer.from(sig.subarray(33, 65)).toString("hex"));
    if (rec === 1) sv = N - sv;
    const sb = Buffer.from(sv.toString(16).padStart(64, "0"), "hex");
    let recAddr = "n/a";
    try {
      const pub = secp256k1.recoverPublicKey(Buffer.concat([Buffer.from([0]), r, sb]), hash, { prehash: false });
      recAddr = Buffer.from(keccak_256(pub.slice(1))).subarray(12).toString("hex");
    } catch (e) {
      recAddr = "recover error: " + e.message;
    }
    console.log(`lowS=${lowS} want=${s.addr.toString("hex")} rec=${rec} got=${recAddr}`);
  }
}
