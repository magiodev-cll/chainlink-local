import type { DecodedMessage } from "./codec.js";

/**
 * The subset of `Client.Any2EVMMessage` the local EVM router consumes.
 *
 * Mirrors `@chainlink/contracts-ccip/contracts/libraries/Client.sol`. Amounts stay `bigint`;
 * ethers accepts them directly for `uint256` fields.
 */
export interface Any2EvmMessage {
  messageId: string;
  sourceChainSelector: bigint;
  sender: string;
  data: string;
  destTokenAmounts: Array<{ token: string; amount: bigint }>;
}

/** Anything that exposes `CCIPLocalRouter.routeMessage`. Usually an ethers `Contract`. */
export interface EvmRouterLike {
  routeMessage(
    message: Any2EvmMessage,
    gasForCallExactCheck: number,
    gasLimit: bigint,
    receiver: string,
  ): Promise<{ hash: string }>;
}

export interface DeliverToEvmOptions {
  router: EvmRouterLike;
  message: Any2EvmMessage;
  /** Receiver contract on the EVM chain. */
  receiver: string;
  gasLimit?: bigint;
  gasForCallExactCheck?: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Hand a CCIP message to a local EVM router.
 *
 * `CCIPLocalRouter.routeMessage` is permissionless and synchronous, so this is the EVM half of
 * the SVM -> EVM direction. The package does not spawn an EVM node: pass a router connected to
 * Anvil, a Foundry fork, or the user's own local chain.
 */
export async function deliverToEvm(opts: DeliverToEvmOptions): Promise<{ hash: string }> {
  const { router, message, receiver } = opts;
  if (!ADDRESS_RE.test(receiver)) throw new Error(`invalid EVM receiver: ${receiver}`);
  if (message.messageId.length !== 66 || !/^0x[0-9a-fA-F]{64}$/.test(message.messageId)) {
    throw new Error(`invalid messageId: ${message.messageId}`);
  }

  return router.routeMessage(
    message,
    opts.gasForCallExactCheck ?? 5_000,
    opts.gasLimit ?? 200_000n,
    receiver,
  );
}

/**
 * Convert a decoded Solana-originated CCIP 2.0 message into the EVM router's shape.
 *
 * `destTokenAmounts` cannot be derived from the SVM message alone: it carries the Solana mint,
 * not the EVM token. Callers that move tokens supply the mapping; data-only messages pass none.
 */
export function toAny2EvmMessage(
  decoded: DecodedMessage,
  messageId: string,
  destTokenAmounts: Array<{ token: string; amount: bigint }> = [],
): Any2EvmMessage {
  if (decoded.tokenTransfer && destTokenAmounts.length === 0) {
    throw new Error(
      "message carries a token transfer; pass destTokenAmounts mapped to EVM token addresses",
    );
  }
  return {
    messageId,
    sourceChainSelector: decoded.sourceChainSelector,
    sender: `0x${Buffer.from(decoded.sender).toString("hex")}`,
    data: `0x${Buffer.from(decoded.data).toString("hex")}`,
    destTokenAmounts,
  };
}
