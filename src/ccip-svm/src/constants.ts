import { PublicKey } from "@solana/web3.js";

/** Solana chain selectors (chainlink-selectors). */
export const SVM_CHAIN_SELECTOR = 16423721717087811551n; // solana-devnet
export const EVM_CHAIN_SELECTOR = 16015286601757825753n; // ethereum-testnet-sepolia

/** CCIP 2.0 program ids. Identical on every cluster: programs are upgradeable. */
export const PROGRAM_IDS = {
  ccipOfframp: "off43sBHBsmWTU6VbfwKYCNwyJ4rSDhunYvz3QL7bF9",
  ccipRouter: "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C",
  feeQuoter: "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi",
  rmnRemote: "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7",
  committeeVerifier: "CV2s8jsYhx9th8pyZ4pN7apLELAB42e5j4XqWhqTdWCm",
  testReceiver: "GsgXbSfG226vCVMfamUhwFgY4kF9HkNiu3wk8Ho8cky5",
} as const;

/** `bytes4(keccak256("CommitteeVerifier 2.0.0"))`. */
/** Fixed source-chain token/pool addresses used by the local fixture. */
export const REMOTE_TOKEN_ADDRESS = Buffer.alloc(20, 7);
export const REMOTE_POOL_ADDRESS = Buffer.alloc(20, 8);

export const CCV_VERSION_TAG = Uint8Array.from([0xe9, 0xa0, 0x5a, 0x20]);

export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export const PROGRAM_DATA_SEED = "reference_addresses";
export const SEEDS = {
  config: "config",
  curses: "curses",
  referenceAddresses: "reference_addresses",
  sourceChain: "source_chain_state",
  messageExecState: "message_exec_state",
  remoteChain: "remote_chain",
  storageLocations: "storage_locations",
  allowedOfframp: "allowed_offramp",
  externalExecutionConfig: "external_execution_config",
  counter: "counter",
} as const;

export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
}

export function pda(seeds: (Uint8Array | Buffer)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function u64LeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}
