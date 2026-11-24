// The EVM half of Canton to EVM: a sent Canton message becomes the struct `CCIPLocalRouter.routeMessage` takes.
// `routeMessage` is already generic, so this is a converter rather than a Solidity change.

/**
 * @param {object} opts
 * @param {string} opts.messageId the id the Canton router reported, not a derived one
 * @param {bigint|string} opts.sourceChainSelector the Canton chain the message came from
 * @param {string} opts.sender 20-byte address; padded to the 32 bytes the EVM router expects
 * @param {Uint8Array|string} opts.data application payload
 * @returns {{messageId: string, sourceChainSelector: bigint, sender: string, data: string, destTokenAmounts: unknown[]}}
 */
export function toAny2EvmMessage({ messageId, sourceChainSelector, sender, data }) {
  if (!messageId) throw new Error("messageId is required; take it from the send result");

  const payload = typeof data === "string" ? data.replace(/^0x/, "") : Buffer.from(data).toString("hex");
  const paddedSender = sender.length === 66 ? sender : `0x${"00".repeat(12)}${sender.replace(/^0x/, "")}`;

  return {
    messageId: messageId.startsWith("0x") ? messageId : `0x${messageId}`,
    sourceChainSelector: BigInt(sourceChainSelector),
    sender: paddedSender,
    data: `0x${payload}`,
    destTokenAmounts: [],
  };
}
