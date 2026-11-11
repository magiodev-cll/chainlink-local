import anchor from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID, createInitializeMint2Instruction } from "@solana/spl-token";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { readIdl, readProgram, resolveArtifacts } from "./artifacts.js";
import {
  addressOf,
  committeeKey,
  encodeDestBlob,
  encodeMessage,
  encodeTokenTransfer,
  messageId,
  signVerifierResults,
} from "./codec.js";
import {
  EVM_CHAIN_SELECTOR,
  PROGRAM_IDS,
  SEEDS,
  SVM_CHAIN_SELECTOR,
  pda,
  programDataAddress,
} from "./constants.js";
import { resolveAccounts } from "./resolver.js";
import { createBurnMintToken, tokenAccountFor } from "./tokens.js";
import type { SendOptions } from "./outbound.js";
import { configureSendLane, sendMessage } from "./outbound.js";
import { confirmSignature, Surfpool } from "./surfpool.js";

const { AnchorProvider, BN, Program, Wallet } = anchor;

const debug = (message: string) => {
  if (process.env.CCIP_SVM_DEBUG) process.stderr.write(`[ccip-svm] ${message}\n`);
};

const SENTINEL_ONRAMP = Buffer.alloc(20, 1);
const DEFAULT_SENDER = Buffer.alloc(20, 2);
const COMMITTEE_SIZE = 8;
const COMMITTEE_THRESHOLD = 1;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Idl = any;

export interface StartOptions {
  /** Attach to an existing Surfpool instead of spawning one. */
  surfpoolUrl?: string;
  /** Path to the surfpool binary. Defaults to `SURFPOOL_BIN` or `surfpool` on PATH. */
  surfpoolBin?: string;
  /** Pre-extracted artifact bundle (`target/` parent). Defaults to `CCIP_SVM_ARTIFACTS`. */
  artifacts?: string;
}

export interface DeliverOptions {
  /** Arbitrary payload delivered to the receiver. */
  data: string | Uint8Array;
  /** Source chain selector. Defaults to Ethereum Sepolia. */
  sourceChainSelector?: bigint;
  /** Source-chain sender bytes. Defaults to a fixed 20-byte sentinel. */
  sender?: Uint8Array;
  /** Receiver program. Defaults to the bundled `test_ccip_receiver`. */
  receiverProgram?: PublicKey;
  /** Receiver accounts carried in the dest blob (after the three fixed CPI accounts). */
  receiverAccounts?: PublicKey[];
  /** Token transfer. The receiver is a wallet; its ATA is derived and created on delivery. */
  token?: {
    mint: PublicKey;
    receiver?: PublicKey;
    amount: bigint;
  };
}

export interface DeliveryResult {
  messageId: string;
  signature: string;
  resolutionTrace: string[];
}

interface Programs {
  offramp: any;
  router: any;
  feeQuoter: any;
  rmnRemote: any;
  committeeVerifier: any;
  receiver: any;
}

/**
 * Local CCIP 2.0 simulator for Solana.
 *
 * Boots a Surfpool instance, deploys the real CCIP programs and wires the trust layer
 * (RMN, FeeQuoter, Router, CommitteeVerifier) to locally generated committee keys. From
 * there, `deliver()` runs an EVM-originated message through the real OffRamp and into a
 * receiver via `ccip_receive`.
 */
export class CcipSvmLocal {
  private readonly surfpool: Surfpool;
  private readonly ownsSurfpool: boolean;
  private readonly payer: Keypair;
  private readonly programs: Programs;
  private readonly offrampId: PublicKey;
  private readonly offrampIdl: Idl;
  private readonly artifactsDir: string;
  private readonly provider: any;
  private linkMint!: PublicKey;
  private sendLaneReady = false;

  private constructor(
    surfpool: Surfpool,
    ownsSurfpool: boolean,
    payer: Keypair,
    programs: Programs,
    offrampId: PublicKey,
    offrampIdl: Idl,
    artifactsDir: string,
    provider: any,
  ) {
    this.surfpool = surfpool;
    this.ownsSurfpool = ownsSurfpool;
    this.payer = payer;
    this.programs = programs;
    this.offrampId = offrampId;
    this.offrampIdl = offrampIdl;
    this.artifactsDir = artifactsDir;
    this.provider = provider;
  }

  static async start(opts: StartOptions = {}): Promise<CcipSvmLocal> {
    debug("resolving artifacts");
    const bundleDir = opts.artifacts ?? (await resolveArtifacts());
    debug(`artifacts at ${bundleDir}`);
    const surfpool = opts.surfpoolUrl
      ? await Surfpool.attach(opts.surfpoolUrl)
      : await Surfpool.start({ bin: opts.surfpoolBin });
    const ownsSurfpool = !opts.surfpoolUrl;
    debug(`surfpool ready at ${surfpool.url}`);

    const payer = Keypair.generate();
    await surfpool.airdrop(payer, 100 * LAMPORTS_PER_SOL);

    const ids = Object.fromEntries(
      Object.entries(PROGRAM_IDS).map(([k, v]) => [k, new PublicKey(v)]),
    ) as Record<keyof typeof PROGRAM_IDS, PublicKey>;

    const names: Record<keyof typeof PROGRAM_IDS, string> = {
      ccipOfframp: "ccip_offramp",
      ccipRouter: "ccip_router",
      feeQuoter: "fee_quoter",
      rmnRemote: "rmn_remote",
      committeeVerifier: "committee_verifier",
      testReceiver: "test_ccip_receiver",
    };

    debug("deploying programs");
    for (const key of Object.keys(ids) as (keyof typeof PROGRAM_IDS)[]) {
      await surfpool.deployProgram(ids[key], readProgram(bundleDir, names[key]));
      await surfpool.setProgramAuthority(ids[key], payer.publicKey);
    }

    const idls = Object.fromEntries(
      Object.keys(ids).map((k) => [k, readIdl(bundleDir, names[k as keyof typeof ids])]),
    ) as Record<keyof typeof ids, Idl>;

    const provider = new AnchorProvider(surfpool.connection, new Wallet(payer), {
      commitment: "confirmed",
    });

    // Anchor confirms over WebSocket, which Surfpool does not serve. Poll instead.
    (provider as any).sendAndConfirm = async (
      tx: Transaction,
      signers: Keypair[] = [],
      opts?: { skipPreflight?: boolean },
    ) => {
      tx.feePayer = tx.feePayer ?? payer.publicKey;
      tx.recentBlockhash = tx.recentBlockhash ?? (await surfpool.connection.getLatestBlockhash()).blockhash;
      tx.sign(payer, ...signers);
      const signature = await surfpool.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: opts?.skipPreflight ?? false,
      });
      await confirmSignature(surfpool.connection, signature);
      return signature;
    };

    const programs: Programs = {
      offramp: new Program(idls.ccipOfframp, provider),
      router: new Program(idls.ccipRouter, provider),
      feeQuoter: new Program(idls.feeQuoter, provider),
      rmnRemote: new Program(idls.rmnRemote, provider),
      committeeVerifier: new Program(idls.committeeVerifier, provider),
      receiver: new Program(idls.testReceiver, provider),
    };

    debug("programs deployed, bootstrapping trust layer");
    const sim = new CcipSvmLocal(
      surfpool,
      ownsSurfpool,
      payer,
      programs,
      ids.ccipOfframp,
      idls.ccipOfframp,
      bundleDir,
      provider,
    );
    await sim.bootstrap(ids);
    debug("bootstrap complete");
    return sim;
  }

  private async bootstrap(ids: Record<keyof typeof PROGRAM_IDS, PublicKey>): Promise<void> {
    const authority = this.payer.publicKey;
    const programData = programDataAddress;
    const selector = Buffer.from(new BN(EVM_CHAIN_SELECTOR.toString()).toArray("le", 8));
    const { offramp, router, feeQuoter, rmnRemote, committeeVerifier, receiver } = this.programs;

    // LINK stand-in mint: FeeQuoter validates ownership, nothing else uses it for inbound.
    // Built by hand because spl-token's createMint confirms over WebSocket.
    const linkMint = Keypair.generate();
    this.linkMint = linkMint.publicKey;
    const mintRent = await this.surfpool.connection.getMinimumBalanceForRentExemption(82);
    const mintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority,
        newAccountPubkey: linkMint.publicKey,
        space: 82,
        lamports: mintRent,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(linkMint.publicKey, 6, authority, null),
    );
    mintTx.feePayer = authority;
    mintTx.recentBlockhash = (await this.surfpool.connection.getLatestBlockhash()).blockhash;
    mintTx.sign(this.payer, linkMint);
    const mintSignature = await this.surfpool.connection.sendRawTransaction(mintTx.serialize(), {
      skipPreflight: false,
    });
    await confirmSignature(this.surfpool.connection, mintSignature);

    await offramp.methods
      .initialize()
      .accounts({
        referenceAddresses: pda([Buffer.from(SEEDS.referenceAddresses)], ids.ccipOfframp),
        router: ids.ccipRouter,
        feeQuoter: ids.feeQuoter,
        rmnRemote: ids.rmnRemote,
        offrampLookupTable: PublicKey.default,
        authority,
        systemProgram: SystemProgram.programId,
        program: ids.ccipOfframp,
        programData: programData(ids.ccipOfframp),
      })
      .rpc();

    await offramp.methods
      .initializeConfig(new BN(SVM_CHAIN_SELECTOR.toString()))
      .accounts({
        config: pda([Buffer.from(SEEDS.config)], ids.ccipOfframp),
        authority,
        systemProgram: SystemProgram.programId,
        program: ids.ccipOfframp,
        programData: programData(ids.ccipOfframp),
      })
      .rpc();

    await rmnRemote.methods
      .initialize()
      .accounts({
        config: pda([Buffer.from(SEEDS.config)], ids.rmnRemote),
        curses: pda([Buffer.from(SEEDS.curses)], ids.rmnRemote),
        authority,
        systemProgram: SystemProgram.programId,
        program: ids.rmnRemote,
        programData: programData(ids.rmnRemote),
      })
      .rpc();

    await feeQuoter.methods
      .initialize(new BN("1000000000000000000"), ids.ccipRouter)
      .accounts({
        config: pda([Buffer.from(SEEDS.config)], ids.feeQuoter),
        linkTokenMint: linkMint.publicKey,
        authority,
        systemProgram: SystemProgram.programId,
        program: ids.feeQuoter,
        programData: programData(ids.feeQuoter),
      })
      .rpc();

    await router.methods
      .initialize(
        new BN(SVM_CHAIN_SELECTOR.toString()),
        authority,
        ids.feeQuoter,
        linkMint.publicKey,
        ids.rmnRemote,
      )
      .accounts({
        config: pda([Buffer.from(SEEDS.config)], ids.ccipRouter),
        authority,
        systemProgram: SystemProgram.programId,
        program: ids.ccipRouter,
        programData: programData(ids.ccipRouter),
      })
      .rpc();

    // Creates the router-owned `allowed_offramp` PDA every receiver checks in `ccip_receive`.
    await router.methods
      .addOfframp(new BN(EVM_CHAIN_SELECTOR.toString()), ids.ccipOfframp)
      .accounts({
        config: pda([Buffer.from(SEEDS.config)], ids.ccipRouter),
        authority,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await committeeVerifier.methods
      .initialize()
      .accounts({
        config: pda([Buffer.from(SEEDS.config)], ids.committeeVerifier),
        storageLocations: pda([Buffer.from(SEEDS.storageLocations)], ids.committeeVerifier),
        authority,
        systemProgram: SystemProgram.programId,
        program: ids.committeeVerifier,
        programData: programData(ids.committeeVerifier),
      })
      .rpc();

    await committeeVerifier.methods
      .initChainConfig({
        remoteChainSelector: new BN(EVM_CHAIN_SELECTOR.toString()),
        chainConfig: {
          routerSigner: pda([Buffer.from("ccv_signer")], ids.ccipRouter),
          fee: 0,
          gasForVerification: 500_000,
          payloadSizeBytes: 390,
        },
      })
      .accounts({
        config: pda([Buffer.from(SEEDS.config)], ids.committeeVerifier),
        authority,
        remoteChainConfig: pda(
          [Buffer.from(SEEDS.remoteChain), selector],
          ids.committeeVerifier,
        ),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const committee = Array.from({ length: COMMITTEE_SIZE }, (_, i) => committeeKey(i)).sort(
      (a, b) => addressOf(a).localeCompare(addressOf(b)),
    );
    await committeeVerifier.methods
      .setSignerConfig({
        sourceChainSelector: new BN(EVM_CHAIN_SELECTOR.toString()),
        threshold: COMMITTEE_THRESHOLD,
        signers: committee.map((k) => Array.from(Buffer.from(addressOf(k).slice(2), "hex"))),
      })
      .accounts({
        config: pda([Buffer.from(SEEDS.config)], ids.committeeVerifier),
        authority,
        remoteChainConfig: pda(
          [Buffer.from(SEEDS.remoteChain), selector],
          ids.committeeVerifier,
        ),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await offramp.methods
      .addSourceChain({
        newChainSelector: new BN(EVM_CHAIN_SELECTOR.toString()),
        sourceChainConfig: {
          isEnabled: true,
          onRamps: [{ bytes: Array.from(Buffer.alloc(64, 1)), len: 20 }],
          defaultCcvs: [ids.committeeVerifier],
          laneMandatedCcvs: [],
          legacyAddressLength: 20,
        },
      })
      .accounts({
        sourceChain: pda([Buffer.from(SEEDS.sourceChain), selector], ids.ccipOfframp),
        config: pda([Buffer.from(SEEDS.config)], ids.ccipOfframp),
        authority,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await receiver.methods
      .initialize(ids.ccipRouter)
      .accounts({
        counter: this.receiverCounter(),
        externalExecutionConfig: this.receiverExternalExecutionConfig(),
        authority,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  get connection() {
    return this.surfpool.connection;
  }

  /** LINK stand-in mint created during bootstrap (fee token config). */
  get linkTokenMint(): PublicKey {
    return this.linkMint;
  }

  /** Send an arbitrary-data message from Solana to the local EVM lane. */
  async send(opts: SendOptions) {
    if (!this.sendLaneReady) {
      await configureSendLane(this.outboundHarness());
      this.sendLaneReady = true;
    }
    return sendMessage(this.outboundHarness(), opts);
  }

  private outboundHarness() {
    return {
      connection: this.surfpool.connection,
      payer: this.payer,
      provider: this.provider,
      linkMint: this.linkMint,
      router: this.programs.router,
      feeQuoter: this.programs.feeQuoter,
      rmnRemote: this.programs.rmnRemote,
      rpc: (method: string, params: unknown[]) => this.surfpool.rpc(method, params),
    };
  }

  /** Deploy a BurnMint pool and wire a fresh SPL mint through the router registry. */
  async createBurnMintToken(opts: { decimals?: number } = {}) {
    return createBurnMintToken(
      {
        connection: this.surfpool.connection,
        payer: this.payer,
        provider: this.provider,
        router: this.programs.router,
        deployProgram: (name, id) => this.deployProgram(name, id),
        rpc: (method, params) => this.surfpool.rpc(method, params),
        readIdl: (name) => readIdl(this.artifactsDir, name),
      },
      opts,
    );
  }

  /** ATA that `deliver` will credit for `mint`. */
  tokenAccountFor(mint: PublicKey, owner: PublicKey = this.payer.publicKey): PublicKey {
    return tokenAccountFor(mint, owner);
  }

  get surfpoolInstance() {
    return this.surfpool;
  }

  get routerProgram() {
    return this.programs.router;
  }

  get payerKeypair() {
    return this.payer;
  }

  /** Deploy any extra program shipped in the pinned artifact bundle. */
  async deployProgram(name: string, programId: PublicKey): Promise<void> {
    await this.surfpool.deployProgram(programId, readProgram(this.artifactsDir, name));
    await this.surfpool.setProgramAuthority(programId, this.payer.publicKey);
  }

  receiverCounter(): PublicKey {
    return pda([Buffer.from(SEEDS.counter)], new PublicKey(PROGRAM_IDS.testReceiver));
  }

  receiverExternalExecutionConfig(): PublicKey {
    return pda(
      [Buffer.from(SEEDS.externalExecutionConfig)],
      new PublicKey(PROGRAM_IDS.testReceiver),
    );
  }

  /** Current counter value in the bundled receiver. Increments once per delivered message. */
  async receiverCounterValue(): Promise<bigint> {
    const account = await this.surfpool.connection.getAccountInfo(this.receiverCounter());
    if (!account) throw new Error("receiver counter is not initialized");
    return account.data.readBigUInt64LE(8);
  }

  async deliver(opts: DeliverOptions): Promise<DeliveryResult> {
    const connection = this.surfpool.connection;
    const authority = this.payer.publicKey;
    const offrampId = this.offrampId;
    const receiverProgram = opts.receiverProgram ?? new PublicKey(PROGRAM_IDS.testReceiver);
    const receiverAccounts =
      opts.receiverAccounts ??
      [
        this.receiverExternalExecutionConfig(),
        this.receiverCounter(),
        SystemProgram.programId,
      ];

    const data =
      typeof opts.data === "string" ? Buffer.from(opts.data) : Buffer.from(opts.data);

    const encodedMessage = encodeMessage({
      sourceChainSelector: opts.sourceChainSelector ?? EVM_CHAIN_SELECTOR,
      destChainSelector: SVM_CHAIN_SELECTOR,
      messageNumber: 1n,
      executionGasLimit: 200_000,
      ccipReceiveGasLimit: 200_000,
      onRampAddress: SENTINEL_ONRAMP,
      offRampAddress: offrampId.toBuffer(),
      sender: opts.sender ?? DEFAULT_SENDER,
      receiver: receiverProgram.toBuffer(),
      destBlob: encodeDestBlob({
        // 0 = DeriveAtaAndCreate. Pool v1 rejects UseAsIs.
        useAta: 0,
        accounts: receiverAccounts,
        accountIsWritableBitmap: 0b11n,
      }),
      tokenTransfer: opts.token
        ? encodeTokenTransfer({
            amount: opts.token.amount,
            sourcePoolAddress: Buffer.alloc(20, 8),
            sourceTokenAddress: Buffer.alloc(20, 7),
            destTokenAddress: opts.token.mint.toBuffer(),
            tokenReceiver: (opts.token.receiver ?? this.payer.publicKey).toBuffer(),
          })
        : undefined,
      data,
    });

    const id = messageId(encodedMessage);
    const committee = Array.from({ length: COMMITTEE_SIZE }, (_, i) => committeeKey(i)).sort(
      (a, b) => addressOf(a).localeCompare(addressOf(b)),
    );
    const verifierResults = signVerifierResults(id, committee, COMMITTEE_THRESHOLD);

    const buildIxData = (metadata: Uint8Array) =>
      Buffer.from(
        this.programs.offramp.coder.instruction.encode("executeV2", {
          params: {
            execInputs: {
              encodedMessage: Buffer.from(encodedMessage),
              ccvs: [new PublicKey(PROGRAM_IDS.committeeVerifier)],
              verifierResults: [verifierResults],
            },
            resolutionMetadata: Buffer.from(metadata),
          },
        }),
      );

    debug("resolving execute accounts");
    const resolved = await resolveAccounts({
      connection,
      programId: offrampId,
      idl: this.offrampIdl,
      payer: this.payer,
      config: pda([Buffer.from(SEEDS.config)], offrampId),
      ixData: buildIxData(Buffer.alloc(0)),
      caller: authority,
    });

    debug(`resolved ${resolved.accounts.length} accounts across ${resolved.trace.length} stages`);
    const executeIx = new TransactionInstruction({
      programId: offrampId,
      keys: resolved.accounts.map((a) => ({
        pubkey: a.pubkey,
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: buildIxData(resolved.metadata),
    });

    // The resolved account list does not fit a legacy transaction; production uses a LUT too.
    debug("creating lookup table");
    const slot = await connection.getSlot();
    const [createIx, lookupTable] = AddressLookupTableProgram.createLookupTable({
      authority,
      payer: authority,
      recentSlot: slot,
    });
    const createTx = new Transaction().add(createIx);
    createTx.feePayer = authority;
    createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    createTx.sign(this.payer);
    await confirmSignature(
      connection,
      await connection.sendRawTransaction(createTx.serialize(), { skipPreflight: false }),
    );

    // A legacy transaction fits ~20 pubkeys; extend large account lists in chunks.
    const addresses = resolved.accounts.map((a) => a.pubkey);
    for (let i = 0; i < addresses.length; i += 20) {
      const extendTx = new Transaction().add(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable,
          authority,
          payer: authority,
          addresses: addresses.slice(i, i + 20),
        }),
      );
      extendTx.feePayer = authority;
      extendTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      extendTx.sign(this.payer);
      await confirmSignature(
        connection,
        await connection.sendRawTransaction(extendTx.serialize(), { skipPreflight: false }),
      );
    }
    await this.surfpool.rpc("surfnet_timeTravel", [{ absoluteSlot: slot + 10 }]);

    debug("sending execute transaction");
    const alt = (await connection.getAddressLookupTable(lookupTable)).value;
    if (!alt) throw new Error("lookup table was not created");
    const message = new TransactionMessage({
      payerKey: authority,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), executeIx],
    }).compileToV0Message([alt]);
    const tx = new VersionedTransaction(message);
    tx.sign([this.payer]);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await confirmSignature(connection, signature);

    return { messageId: id.toString("hex"), signature, resolutionTrace: resolved.trace };
  }

  async stop(): Promise<void> {
    if (this.ownsSurfpool) await this.surfpool.stop();
  }
}
