// The EVM half of Canton to EVM: a Canton message becomes the struct `CCIPLocalRouter.routeMessage` takes.
// `routeMessage` is already generic, so this is a converter rather than a Solidity change.

import { getBytes } from "ethers";

/**
 * @param {object} opts
 * @param {bigint|string} opts.sourceChainSelector the Canton chain the message came from
 * @param {string} opts.sender 20-byte address, ABI-padded to 32 bytes as the EVM router expects
 * @param {Uint8Array|string} opts.data application payload
 * @param {string} [opts.messageId] defaults to the keccak of the payload
 * @returns {{messageId: string, sourceChainSelector: bigint, sender: string, data: string, destTokenAmounts: unknown[]}}
 */
export function toAny2EvmMessage({ sourceChainSelector, sender, data, messageId }) {
  const payload = typeof data === "string" ? data : Buffer.from(data).toString("hex");
  const paddedSender = sender.length === 66 ? sender : `0x${"00".repeat(12)}${sender.replace(/^0x/, "")}`;

  return {
    messageId: messageId ?? `0x${Buffer.from(getBytes(payload)).toString("hex").padStart(64, "0").slice(-64)}`,
    sourceChainSelector: BigInt(sourceChainSelector),
    sender: paddedSender,
    data: payload.startsWith("0x") ? payload : `0x${payload}`,
    destTokenAmounts: [],
  };
}
