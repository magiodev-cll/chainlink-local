// CCIP 2.0 message wire format for Canton, ported from `CCIP.CodecV2.MessageCodecV1`.
// Fixed big-endian header, then length-prefixed fields, same order as the EVM encoding.

import { getBytes, keccak256 } from "ethers";

/**
 * @param {object} m
 * @param {bigint} m.sourceChainSelector
 * @param {bigint} m.destChainSelector
 * @param {bigint} m.sequenceNumber
 * @param {number} m.executionGasLimit
 * @param {number} m.ccipReceiveGasLimit
 * @param {Uint8Array} m.finality 4 raw bytes
 * @param {Uint8Array} m.ccvAndExecutorHash 32 bytes
 * @param {Uint8Array} m.onRampAddress
 * @param {Uint8Array} m.offRampAddress
 * @param {Uint8Array} m.sender
 * @param {Uint8Array} m.receiver
 * @param {Uint8Array} m.destBlob
 * @param {Uint8Array} [m.tokenTransfer]
 * @param {Uint8Array} m.messageData
 * @returns {Uint8Array}
 */
export function encodeMessageV1(m) {
  if (m.finality.length !== 4) throw new Error("finality must be 4 bytes");
  if (m.ccvAndExecutorHash.length !== 32) throw new Error("ccvAndExecutorHash must be 32 bytes");

  return concat(
    u8(1),
    u64(m.sourceChainSelector),
    u64(m.destChainSelector),
    u64(m.sequenceNumber),
    u32(m.executionGasLimit),
    u32(m.ccipReceiveGasLimit),
    m.finality,
    m.ccvAndExecutorHash,
    lenU8(m.onRampAddress),
    lenU8(m.offRampAddress),
    lenU8(m.sender),
    lenU8(m.receiver),
    lenU16(m.destBlob),
    lenU16(m.tokenTransfer ?? new Uint8Array()),
    lenU16(m.messageData),
  );
}

export function messageId(encoded) {
  return keccak256(encoded);
}

/** `keccak256(utf8(text))`, how a party or an instance address is known cross-chain. */
export function hashAddress(text) {
  return getBytes(keccak256(Buffer.from(text, "utf8")));
}

/** 4-byte finality config. Zero depth is `WaitForFinality`, otherwise `BlockDepth`. */
export function finalityConfig(blockDepth = 0) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint16(2, blockDepth);
  return out;
}

/** 20-byte EVM address as the 32-byte word the codec expects. */
export function evmAddressToBytes32(address) {
  const raw = getBytes(address);
  if (raw.length !== 20) throw new Error("expected a 20-byte address");
  const out = new Uint8Array(32);
  out.set(raw, 12);
  return out;
}

export function hexToBytes(hex) {
  return getBytes(`0x${hex.replace(/^0x/, "")}`);
}

export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

const u8 = (n) => Uint8Array.of(n);

const u32 = (n) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};

const u64 = (n) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
};

const lenU8 = (v) => concat(u8(v.length), v);

const lenU16 = (v) => {
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, v.length);
  return concat(prefix, v);
};

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
