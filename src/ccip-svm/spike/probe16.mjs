import fs from "node:fs";
import path from "node:path";
import { Connection } from "@solana/web3.js";

const RPC = "http://127.0.0.1:8899";
const ART = process.env.ART;

const PROGRAMS = {
  ccip_offramp: "offqSMQWgQud6WJz694LRzkeN5kMYpCHTpXQr3Rkcjm",
  ccip_router: "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C",
  fee_quoter: "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi",
  rmn_remote: "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7",
  test_ccip_receiver: "EvhgrPhTDt4LcSPS2kfJgH6T6XWZ6wT3X9ncDGLT1vui",
};

const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((x) => x.json());
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};

const connection = new Connection(RPC, "confirmed");
for (const [name, id] of Object.entries(PROGRAMS)) {
  const bytes = fs.readFileSync(path.join(ART, "target/deploy", `${name}.so`));
  const hex = bytes.toString("hex");
  const CHUNK = 15 * 1024 * 1024;
  for (let off = 0; off < hex.length; off += CHUNK * 2) {
    await rpc("surfnet_writeProgram", [id, hex.slice(off, off + CHUNK * 2), off / 2]);
  }
  const acct = await connection.getAccountInfo(new (await import("@solana/web3.js")).PublicKey(id));
  console.log(name.padEnd(24), "executable:", acct?.executable, "bytes:", bytes.length);
}
