import fs from "node:fs";
import path from "node:path";
import anchor from "@anchor-lang/core";
import web3 from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const ROOT = path.resolve(import.meta.dirname, "../../..");
const CACHE = path.join(ROOT, ".ccip-svm-cache");
const kp = web3.Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(CACHE, "id.json"), "utf8"))),
);
const provider = new AnchorProvider(new web3.Connection("http://127.0.0.1:8899", "confirmed"), new Wallet(kp), {
  commitment: "confirmed",
});
const cv = new Program(
  JSON.parse(fs.readFileSync(path.join(CACHE, "artifacts-2.0/target/idl/committee_verifier.json"), "utf8")),
  provider,
);

const EVM = 16015286601757825753n;
const sel = Buffer.from(new BN(EVM.toString()).toArray("le", 8));
const CV = "CV2s8jsYhx9th8pyZ4pN7apLELAB42e5j4XqWhqTdWCm";
const cfgPda = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], new web3.PublicKey(CV))[0];
const remotePda = web3.PublicKey.findProgramAddressSync([Buffer.from("remote_chain"), sel], new web3.PublicKey(CV))[0];

const VERSION_TAG = Buffer.from([0xe9, 0xa0, 0x5a, 0x20]);
const messageId = Buffer.alloc(32, 9);
const hash = Buffer.from(keccak_256(Buffer.concat([VERSION_TAG, messageId])));

function sigFor(i) {
  const priv = keccak_256(Buffer.from(`chainlink-local-svm-signer-${i}`));
  const sig = secp256k1.sign(hash, priv, { lowS: true, format: "recovered" });
  return { priv, rec: sig[0], bytes: Buffer.from(sig.subarray(1)) };
}

for (let i = 0; i < 8; i++) {
  const s = sigFor(i);
  if (s.rec !== 0) continue;
  const body = Buffer.concat([Buffer.from([0x00, 0x40]), s.bytes]); // u16 BE len = 64
  const verifierResults = Buffer.concat([VERSION_TAG, body]);
  try {
    const sig = await cv.methods
      .verify({ messageId: Array.from(messageId), encodedMessage: Buffer.alloc(0), verifierResults })
      .accounts({ config: cfgPda, remoteChainConfig: remotePda })
      .rpc();
    console.log(`signer ${i} OK`, sig);
    break;
  } catch (e) {
    console.log(`signer ${i} FAIL`, String(e.message).slice(0, 200));
  }
}
