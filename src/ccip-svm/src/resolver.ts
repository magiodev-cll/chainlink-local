import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export interface ResolvedAccount {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

export interface ResolveResult {
  accounts: ResolvedAccount[];
  metadata: Uint8Array;
  accountListLengths: Uint8Array;
  trace: string[];
}

interface IdlInstruction {
  name: string;
  discriminator: number[];
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** Borsh: `ResolveAccountsParams { caller: Pubkey, ix_data: Vec<u8>, metadata: Vec<u8> }`. */
function encodeResolveParams(caller: PublicKey, ixData: Uint8Array, metadata: Uint8Array): Buffer {
  return Buffer.concat([
    caller.toBuffer(),
    u32(ixData.length),
    Buffer.from(ixData),
    u32(metadata.length),
    Buffer.from(metadata),
  ]);
}

function decodeResponse(buf: Buffer) {
  let o = 0;
  const readU32 = () => {
    const v = buf.readUInt32LE(o);
    o += 4;
    return v;
  };
  const readPubkey = () => {
    const k = new PublicKey(buf.subarray(o, o + 32));
    o += 32;
    return k;
  };

  const askAgain = Array.from({ length: readU32() }, readPubkey);
  const accounts: ResolvedAccount[] = [];
  for (let i = 0, n = readU32(); i < n; i++) {
    const pubkey = readPubkey();
    const isSigner = buf[o++] === 1;
    const isWritable = buf[o++] === 1;
    accounts.push({ pubkey, isSigner, isWritable });
  }
  const lookupTables = Array.from({ length: readU32() }, readPubkey);
  const hasNext = buf[o++];
  const nextDiscriminator = hasNext ? Buffer.from(buf.subarray(o, (o += 8))) : null;
  const metadataLength = readU32();
  const metadata = Buffer.from(buf.subarray(o, o + metadataLength));
  return { askAgain, accounts, lookupTables, nextDiscriminator, metadata };
}

/**
 * Drive a program's staged account resolver.
 *
 * Every CCIP 2.0 program exposes the same `resolve_accounts_start` entrypoint and threads state
 * through `next_ix_discriminator` / `metadata`. The whole process is read-only simulation, so it
 * costs nothing and never touches state.
 */
export async function resolveAccounts(opts: {
  connection: Connection;
  programId: PublicKey;
  idl: { instructions: IdlInstruction[] };
  payer: Keypair;
  config: PublicKey;
  /** Borsh-encoded instruction data of the instruction being resolved. */
  ixData: Uint8Array;
  /** Account that will sign the final instruction (usually the payer). */
  caller: PublicKey;
  /** Max resolution rounds before bailing out. */
  maxRounds?: number;
}): Promise<ResolveResult> {
  const { connection, programId, idl, payer, config, caller } = opts;
  const stageName = new Map(
    idl.instructions.map((i) => [Buffer.from(i.discriminator).toString("hex"), i.name]),
  );
  const start = idl.instructions.find((i) => i.name === "resolve_accounts_start");
  if (!start) throw new Error("program IDL has no resolve_accounts_start");

  const accounts: ResolvedAccount[] = [];
  const trace: string[] = [];
  let discriminator = Buffer.from(start.discriminator);
  let metadata = new Uint8Array(0);
  let accountKeys = [config];

  for (let round = 0; round < (opts.maxRounds ?? 32); round++) {
    const data = Buffer.concat([
      discriminator,
      encodeResolveParams(caller, opts.ixData, metadata),
    ]);
    const ix = new TransactionInstruction({
      programId,
      keys: accountKeys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      data,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(payer);

    const res = await connection.simulateTransaction(tx);
    if (res.value.err) {
      throw new Error(
        `account resolution failed at ${stageName.get(discriminator.toString("hex"))}: ` +
          `${JSON.stringify(res.value.err)}\n${(res.value.logs ?? []).join("\n")}`,
      );
    }

    const prefix = `Program return: ${programId.toBase58()} `;
    const line = (res.value.logs ?? []).find((l) => l.startsWith(prefix));
    if (!line) throw new Error("account resolution returned no data");

    const raw = Buffer.from(line.slice(prefix.length), "base64");
    if (process.env.CCIP_SVM_DUMP) process.stderr.write(`[raw] ${raw.toString("base64")}\n`);
    const response = decodeResponse(raw);
    if (process.env.CCIP_SVM_DEBUG) {
      process.stderr.write(
        `[ccip-svm]   round ${round} ${stageName.get(discriminator.toString("hex"))}: ` +
          `save=${response.accounts.length} ask=${response.askAgain.length} ` +
          `meta=${metadata.length}->${response.metadata.length} ` +
          `next=${response.nextDiscriminator ? stageName.get(response.nextDiscriminator.toString("hex")) : "done"} ` +
          `ask=[${response.askAgain.map((k) => k.toBase58().slice(0, 6)).join(",")}] ` +
          `meta=${Buffer.from(response.metadata).toString("hex")}\n`,
      );
    }
    accounts.push(...response.accounts);
    trace.push(stageName.get(discriminator.toString("hex")) ?? discriminator.toString("hex"));

    if (!response.nextDiscriminator) {
      return {
        accounts,
        metadata: response.metadata,
        accountListLengths: response.metadata.subarray(0, 5),
        trace,
      };
    }

    discriminator = response.nextDiscriminator;
    metadata = response.metadata;
    accountKeys = response.askAgain;
  }

  throw new Error("account resolution exceeded the maximum number of rounds");
}
