import fs from "node:fs";
import path from "node:path";
import anchor from "@anchor-lang/core";
import web3 from "@solana/web3.js";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const { Connection, Keypair, PublicKey } = web3;
const ROOT = path.resolve(import.meta.dirname, "../../..");
const CACHE = path.join(ROOT, ".ccip-svm-cache");
const idl = JSON.parse(
  fs.readFileSync(path.join(CACHE, "artifacts-2.0/target/idl/ccip_offramp.json"), "utf8"),
);
const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(CACHE, "id.json"), "utf8"))),
);
const provider = new AnchorProvider(new Connection("http://127.0.0.1:8899", "confirmed"), new Wallet(kp), {
  commitment: "confirmed",
});
const offramp = new Program(idl, provider);
const pda = (seeds, id) => PublicKey.findProgramAddressSync(seeds, new PublicKey(id))[0];

const EVM = 16015286601757825753n;
const sel = Buffer.from(new BN(EVM.toString()).toArray("le", 8));

try {
  const sig = await offramp.methods
    .addSourceChain({
      newChainSelector: new BN(EVM.toString()),
      sourceChainConfig: {
        isEnabled: true,
        onRamps: [{ bytes: Array.from(Buffer.alloc(64, 1)), len: 20 }],
        defaultCcvs: [new PublicKey("CV2s8jsYhx9th8pyZ4pN7apLELAB42e5j4XqWhqTdWCm")],
        laneMandatedCcvs: [],
        legacyAddressLength: 20,
      },
    })
    .accounts({
      sourceChain: pda([Buffer.from("source_chain_state"), sel], "off43sBHBsmWTU6VbfwKYCNwyJ4rSDhunYvz3QL7bF9"),
      config: pda([Buffer.from("config")], "off43sBHBsmWTU6VbfwKYCNwyJ4rSDhunYvz3QL7bF9"),
      authority: kp.publicKey,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();
  console.log("OK", sig);
} catch (e) {
  console.log('MESSAGE:', e.message); console.log('LOGS:', (e.logs||[]).join('\n')); console.log('ERROR:', e.error); console.log(String(e.stack).slice(0,1500));
}
