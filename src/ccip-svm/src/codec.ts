import { PublicKey } from "@solana/web3.js";
import { SigningKey, computeAddress, keccak256, getBytes } from "ethers";
import { CCV_VERSION_TAG } from "./constants.js";

/** The CCIP 2.0 wire format is a custom versioned codec, NOT borsh. */
export interface MessageV1 {
  sourceChainSelector: bigint;
  destChainSelector: bigint;
  messageNumber: bigint;
  executionGasLimit: number;
  ccipReceiveGasLimit: number;
  finalityFlags?: number;
  finalityBlockDepth?: number;
  ccvAndExecutorHash?: Uint8Array;
  onRampAddress: Uint8Array;
  offRampAddress: Uint8Array;
  sender: Uint8Array;
  receiver: Uint8Array;
  destBlob: Uint8Array;
  /** Optional encoded TokenTransferV1. */
  tokenTransfer?: Uint8Array;
  data: Uint8Array;
}

/** TokenTransferV1: custom versioned codec, not borsh. */
export interface TokenTransferV1 {
  amount: bigint;
  sourcePoolAddress: Uint8Array;
  sourceTokenAddress: Uint8Array;
  destTokenAddress: Uint8Array;
  tokenReceiver: Uint8Array;
  extraData?: Uint8Array;
}

export function encodeTokenTransfer(t: TokenTransferV1): Buffer {
  const amount = Buffer.alloc(32);
  amount.writeBigUInt64BE(t.amount, 24);
  return Buffer.concat([
    Buffer.from([1]),
    amount,
    lenU8(t.sourcePoolAddress),
    lenU8(t.sourceTokenAddress),
    lenU8(t.destTokenAddress),
    lenU8(t.tokenReceiver),
    lenU16(t.extraData ?? new Uint8Array(0)),
  ]);
}

const beU64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};
const beU32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const beU16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const lenU8 = (v: Uint8Array) => Buffer.concat([Buffer.from([v.length]), Buffer.from(v)]);
const lenU16 = (v: Uint8Array) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v.length);
  return Buffer.concat([b, Buffer.from(v)]);
};

export function encodeMessage(m: MessageV1): Buffer {
  return Buffer.concat([
    Buffer.from([1]), // MESSAGE_V1_VERSION
    beU64(m.sourceChainSelector),
    beU64(m.destChainSelector),
    beU64(m.messageNumber),
    beU32(m.executionGasLimit),
    beU32(m.ccipReceiveGasLimit),
    beU16(m.finalityFlags ?? 0),
    beU16(m.finalityBlockDepth ?? 0),
    Buffer.from(m.ccvAndExecutorHash ?? new Uint8Array(32)),
    lenU8(m.onRampAddress),
    lenU8(m.offRampAddress),
    lenU8(m.sender),
    lenU8(m.receiver),
    lenU16(m.destBlob),
    lenU16(m.tokenTransfer ?? new Uint8Array(0)),
    lenU16(m.data),
  ]);
}

export interface DecodedMessage extends Omit<MessageV1, "tokenTransfer"> {
  tokenTransfer?: TokenTransferV1;
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  get remaining() {
    return this.buf.length - this.offset;
  }
  u8() {
    return this.buf[this.offset++];
  }
  u16() {
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }
  u32() {
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  u64() {
    const v = this.buf.readBigUInt64BE(this.offset);
    this.offset += 8;
    return v;
  }
  bytes(n: number) {
    const v = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
  lenU8() {
    return this.bytes(this.u8());
  }
  lenU16() {
    return this.bytes(this.u16());
  }
}

export function decodeTokenTransfer(r: Reader): TokenTransferV1 {
  const version = r.u8();
  if (version !== 1) throw new Error(`unsupported TokenTransferV1 version ${version}`);
  const amount = r.bytes(32);
  const sourcePoolAddress = r.lenU8();
  const sourceTokenAddress = r.lenU8();
  const destTokenAddress = r.lenU8();
  const tokenReceiver = r.lenU8();
  const extraData = r.lenU16();
  return {
    amount: BigInt("0x" + Buffer.from(amount).toString("hex")),
    sourcePoolAddress,
    sourceTokenAddress,
    destTokenAddress,
    tokenReceiver,
    extraData,
  };
}

/** Decode the 2.0 `MessageV1` wire format. Inverse of {@link encodeMessage}. */
export function decodeMessage(encodedMessage: Uint8Array): DecodedMessage {
  const r = new Reader(Buffer.from(encodedMessage));
  const version = r.u8();
  if (version !== 1) throw new Error(`unsupported MessageV1 version ${version}`);
  const sourceChainSelector = r.u64();
  const destChainSelector = r.u64();
  const messageNumber = r.u64();
  const executionGasLimit = r.u32();
  const ccipReceiveGasLimit = r.u32();
  const finalityFlags = r.u16();
  const finalityBlockDepth = r.u16();
  const ccvAndExecutorHash = r.bytes(32);
  const onRampAddress = r.lenU8();
  const offRampAddress = r.lenU8();
  const sender = r.lenU8();
  const receiver = r.lenU8();
  const destBlob = r.lenU16();
  const tokenTransferBytes = r.lenU16();
  const data = r.lenU16();
  if (r.remaining !== 0) throw new Error("trailing bytes in MessageV1");

  return {
    sourceChainSelector,
    destChainSelector,
    messageNumber,
    executionGasLimit,
    ccipReceiveGasLimit,
    finalityFlags,
    finalityBlockDepth,
    ccvAndExecutorHash,
    onRampAddress,
    offRampAddress,
    sender,
    receiver,
    destBlob,
    tokenTransfer:
      tokenTransferBytes.length > 0
        ? decodeTokenTransfer(new Reader(Buffer.from(tokenTransferBytes)))
        : undefined,
    data,
  };
}

export function messageId(encodedMessage: Uint8Array): Buffer {
  return Buffer.from(getBytes(keccak256(encodedMessage)));
}

/**
 * SVM executor args / dest blob. `tag` selects the encoding: the big-endian tag is the
 * `abi.encodePacked` layout, the little-endian tag is borsh.
 */
export interface DestBlob {
  useAta?: number;
  accountIsWritableBitmap?: bigint;
  accounts: PublicKey[];
}

const DEST_BLOB_TAG_BE = Buffer.from([0x1a, 0x2b, 0x3c, 0x4d]);
const DEST_BLOB_TAG_LE = Buffer.from([0x4d, 0x3c, 0x2b, 0x1a]);

export function encodeDestBlob(blob: DestBlob, encoding: "packed" | "borsh" = "packed"): Buffer {
  const accountsLen = blob.accounts.length;
  const head = [
    encoding === "packed" ? DEST_BLOB_TAG_BE : DEST_BLOB_TAG_LE,
    Buffer.from([blob.useAta ?? 0]),
    Buffer.from(beU64(blob.accountIsWritableBitmap ?? 0n)),
  ];
  const len = encoding === "packed" ? Buffer.from([accountsLen]) : beU32(accountsLen);
  return Buffer.concat([...head, len, ...blob.accounts.map((a) => a.toBuffer())]);
}

/**
 * CommitteeVerifier verifier-results blob:
 * `u8[4] version_tag | u16 BE sig_byte_len | N x 64-byte signatures`.
 *
 * The on-chain verifier recovers with `recovery_id = 0` and does not inspect the parity bit,
 * so signatures whose natural recovery id is 1 are normalised by flipping `s` to `n - s`.
 */
export function signVerifierResults(
  messageIdBytes: Uint8Array,
  privateKeys: Uint8Array[],
  threshold = 1,
): Buffer {
  const signedHash = keccak256(
    Buffer.concat([Buffer.from(CCV_VERSION_TAG), Buffer.from(messageIdBytes)]),
  );
  const signatures: Buffer[] = [];

  for (const key of privateKeys) {
    if (signatures.length === threshold) break;
    const signer = new SigningKey(`0x${Buffer.from(key).toString("hex")}`);
    const sig = signer.sign(signedHash);
    let s = BigInt(sig.s);
    if (sig.v === 28) s = SECP256K1_N - s;
    signatures.push(
      Buffer.concat([
        Buffer.from(sig.r.slice(2), "hex"),
        Buffer.from(s.toString(16).padStart(64, "0"), "hex"),
      ]),
    );
  }

  if (signatures.length < threshold) throw new Error("not enough signers");

  const body = Buffer.concat(signatures);
  const out = Buffer.alloc(4 + 2 + body.length);
  Buffer.from(CCV_VERSION_TAG).copy(out, 0);
  out.writeUInt16BE(body.length, 4);
  body.copy(out, 6);
  return out;
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Deterministic local committee key: same seed always yields the same address. */
export function committeeKey(seed: string | number): Uint8Array {
  return getBytes(keccak256(Buffer.from(`chainlink-local-svm:${seed}`)));
}

export function addressOf(privateKey: Uint8Array): string {
  const signer = new SigningKey(`0x${Buffer.from(privateKey).toString("hex")}`);
  return computeAddress(signer.publicKey).toLowerCase();
}
