import anchor from "@anchor-lang/core";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  BPF_LOADER_UPGRADEABLE,
  EVM_CHAIN_SELECTOR,
  PROGRAM_IDS,
  REMOTE_POOL_ADDRESS,
  REMOTE_TOKEN_ADDRESS,
  SEEDS,
  pda,
  u64LeBytes,
} from "./constants.js";
import { confirmSignature } from "./surfpool.js";

export const BURN_MINT_POOL = new PublicKey("41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB");
export const BURN_MINT_POOL_IDL = "burnmint_token_pool";

const { AnchorProvider, BN, Program } = anchor;
type AnchorProvider = InstanceType<typeof AnchorProvider>;

export interface TokenHarness {
  connection: Connection;
  payer: Keypair;
  provider: AnchorProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router: { methods: any; coder: any };
  deployProgram(name: string, id: PublicKey): Promise<void>;
  rpc(method: string, params: unknown[]): Promise<unknown>;
  readIdl(name: string): unknown;
}

const programData = (id: PublicKey) =>
  PublicKey.findProgramAddressSync([id.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
const position = (mint: PublicKey) =>
  pda([Buffer.from("ccip_tokenpool_config"), mint.toBuffer()], BURN_MINT_POOL);

async function send(
  harness: TokenHarness,
  build: () => Promise<Transaction> | Transaction,
  signers: Keypair[] = [],
): Promise<string> {
  const tx = await build();
  tx.feePayer = harness.payer.publicKey;
  tx.recentBlockhash = (await harness.connection.getLatestBlockhash()).blockhash;
  tx.sign(harness.payer, ...signers);
  const signature = await harness.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await confirmSignature(harness.connection, signature);
  return signature;
}

/** Deploy the BurnMint pool and wire a fresh SPL mint through the router's token registry. */
export async function createBurnMintToken(
  harness: TokenHarness,
  opts: { decimals?: number } = {},
) {
  const { connection, payer, router } = harness;
  const decimals = opts.decimals ?? 6;
  const authority = payer.publicKey;

  await harness.deployProgram(BURN_MINT_POOL_IDL, BURN_MINT_POOL);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = new Program(harness.readIdl(BURN_MINT_POOL_IDL) as any, harness.provider);

  const poolConfig = pda([Buffer.from(SEEDS.config)], BURN_MINT_POOL);
  const mint = Keypair.generate();
  const mintAddress = mint.publicKey;
  const state = position(mintAddress);
  const poolSigner = pda([Buffer.from("ccip_tokenpool_signer"), mintAddress.toBuffer()], BURN_MINT_POOL);
  const poolAta = getAssociatedTokenAddressSync(mintAddress, poolSigner, true);
  const chainConfig = pda(
    [Buffer.from("ccip_tokenpool_chainconfig"), u64LeBytes(EVM_CHAIN_SELECTOR), mintAddress.toBuffer()],
    BURN_MINT_POOL,
  );
  const routerConfig = pda([Buffer.from(SEEDS.config)], new PublicKey(PROGRAM_IDS.ccipRouter));
  const adminRegistry = pda(
    [Buffer.from("token_admin_registry"), mintAddress.toBuffer()],
    new PublicKey(PROGRAM_IDS.ccipRouter),
  );
  const feeBilling = pda(
    [Buffer.from("fee_billing_token_config"), mintAddress.toBuffer()],
    new PublicKey(PROGRAM_IDS.feeQuoter),
  );
  const routerPoolSigner = pda(
    [Buffer.from("external_token_pools_signer"), BURN_MINT_POOL.toBuffer()],
    new PublicKey(PROGRAM_IDS.ccipRouter),
  );

  await send(harness, () =>
    pool.methods
      .initGlobalConfig(new PublicKey(PROGRAM_IDS.ccipRouter), new PublicKey(PROGRAM_IDS.rmnRemote))
      .accounts({
        config: poolConfig,
        authority,
        systemProgram: SystemProgram.programId,
        program: BURN_MINT_POOL,
        programData: programData(BURN_MINT_POOL),
      })
      .transaction(),
  );

  const rent = await connection.getMinimumBalanceForRentExemption(82);
  await send(harness, () => {
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority,
        newAccountPubkey: mintAddress,
        space: 82,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintAddress, decimals, authority, null),
    );
    return tx;
  }, [mint]);

  await send(harness, async () => {
    const { createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
    return new Transaction().add(
      createAssociatedTokenAccountInstruction(authority, poolAta, poolSigner, mintAddress),
    );
  });

  await send(harness, () =>
    pool.methods
      .initialize()
      .accounts({
        state,
        mint: mintAddress,
        authority,
        systemProgram: SystemProgram.programId,
        program: BURN_MINT_POOL,
        programData: programData(BURN_MINT_POOL),
        config: poolConfig,
      })
      .transaction(),
  );

  await send(harness, async () => {
    const { AuthorityType, createSetAuthorityInstruction } = await import("@solana/spl-token");
    return new Transaction().add(
      createSetAuthorityInstruction(mintAddress, authority, AuthorityType.MintTokens, poolSigner),
    );
  });

  await send(harness, () =>
    pool.methods
      .initChainRemoteConfig(new BN(EVM_CHAIN_SELECTOR.toString()), mintAddress, {
        poolAddresses: [],
        tokenAddress: { address: Buffer.from(REMOTE_TOKEN_ADDRESS) },
        decimals,
      })
      .accounts({ state, chainConfig, authority, systemProgram: SystemProgram.programId })
      .transaction(),
  );

  await send(harness, () =>
    pool.methods
      .appendRemotePoolAddresses(new BN(EVM_CHAIN_SELECTOR.toString()), mintAddress, [
        { address: Buffer.from(REMOTE_POOL_ADDRESS) },
      ])
      .accounts({ state, chainConfig, authority, systemProgram: SystemProgram.programId })
      .transaction(),
  );

  await send(harness, () =>
    pool.methods
      .setChainRateLimit(
        new BN(EVM_CHAIN_SELECTOR.toString()),
        mintAddress,
        { enabled: true, capacity: new BN("1000000000000"), rate: new BN("1000000000") },
        { enabled: false, capacity: new BN(0), rate: new BN(0) },
      )
      .accounts({ state, chainConfig, authority })
      .transaction(),
  );

  await send(harness, () =>
    router.methods
      .ccipAdminProposeAdministrator(authority)
      .accounts({
        config: routerConfig,
        tokenAdminRegistry: adminRegistry,
        mint: mintAddress,
        authority,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );

  await send(harness, () =>
    router.methods
      .acceptAdminRoleTokenAdminRegistry()
      .accounts({ config: routerConfig, tokenAdminRegistry: adminRegistry, mint: mintAddress, authority })
      .transaction(),
  );

  // Mandatory lookup-table prefix validated by `set_pool`, in order.
  const slot = await connection.getSlot();
  const [createIx, lookupTable] = AddressLookupTableProgram.createLookupTable({
    authority,
    payer: authority,
    recentSlot: slot,
  });
  const entries = [
    lookupTable,
    adminRegistry,
    BURN_MINT_POOL,
    state,
    poolAta,
    poolSigner,
    TOKEN_PROGRAM_ID,
    mintAddress,
    feeBilling,
    routerPoolSigner,
  ];
  await send(harness, () => {
    const tx = new Transaction().add(createIx);
    return tx;
  });
  for (let i = 0; i < entries.length; i += 20) {
    await send(harness, () =>
      new Transaction().add(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable,
          authority,
          payer: authority,
          addresses: entries.slice(i, i + 20),
        }),
      ),
    );
  }
  await harness.rpc("surfnet_timeTravel", [{ absoluteSlot: slot + 10 }]);

  // 3 = pool state, 4 = pool token account, 7 = mint: the pool CPI mutates all three.
  await send(harness, () =>
    router.methods
      .setPool(Buffer.from([3, 4, 7]))
      .accounts({
        config: routerConfig,
        tokenAdminRegistry: adminRegistry,
        mint: mintAddress,
        poolLookuptable: lookupTable,
        authority,
      })
      .transaction(),
  );

  return { mint: mintAddress, pool: BURN_MINT_POOL, poolState: state };
}

/** Derive the ATA the OffRamp will credit for `mint` and `owner`. */
export function tokenAccountFor(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner);
}

export type { TransactionInstruction };
