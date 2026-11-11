import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const PROGRAM_CHUNK_BYTES = 15 * 1024 * 1024;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForRpc(connection: Connection, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await connection.getSlot();
      return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`surfpool did not become healthy within ${timeoutMs}ms`);
}

/**
 * Wait for a transaction without WebSocket subscriptions.
 *
 * `confirmTransaction` subscribes over WS, which Surfpool does not serve reliably in `--ci`
 * mode; polling `getSignatureStatuses` works everywhere and gives a bounded failure.
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) {
      throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`transaction ${signature} was not confirmed within ${timeoutMs}ms`);
}

/**
 * A Surfpool instance, either spawned by the harness or attached to one the user already runs.
 *
 * Spawning always uses `--offline --no-deploy --no-tui --no-studio --ci`: no datasource, no
 * generated runbook, no TUI, no Studio, and a non-interactive process suitable for CI.
 */
export class Surfpool {
  readonly connection: Connection;
  readonly url: string;
  private child?: ChildProcess;

  private constructor(url: string, child?: ChildProcess) {
    this.url = url;
    this.connection = new Connection(url, "confirmed");
    this.child = child;
  }

  static async start(opts: { bin?: string; port?: number } = {}): Promise<Surfpool> {
    const bin = opts.bin ?? process.env.SURFPOOL_BIN ?? "surfpool";
    const port = opts.port ?? (await freePort());
    const wsPort = await freePort();
    const url = `http://127.0.0.1:${port}`;

    const child = spawn(
      bin,
      [
        "start",
        "--offline",
        "--no-deploy",
        "--no-tui",
        "--no-studio",
        "--ci",
        "--port",
        String(port),
        "--ws-port",
        String(wsPort),
      ],
      { stdio: ["ignore", "ignore", "pipe"], detached: true },
    );

    let stderr = "";
    child.stderr?.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
    child.once("error", (err) => (stderr += String(err)));
    child.once("exit", (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`surfpool exited (${code}): ${stderr.slice(-800)}\n`);
      }
    });

    const instance = new Surfpool(url, child);
    await waitForRpc(instance.connection);
    return instance;
  }

  static async attach(url = "http://127.0.0.1:8899"): Promise<Surfpool> {
    const instance = new Surfpool(url);
    await waitForRpc(instance.connection, 5_000);
    return instance;
  }

  async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  }

  /** Write a program's bytes directly at a chosen address. No keypair, no BPF loader dance. */
  async deployProgram(programId: PublicKey, bytes: Uint8Array): Promise<void> {
    const hex = Buffer.from(bytes).toString("hex");
    for (let offset = 0; offset < hex.length; offset += PROGRAM_CHUNK_BYTES * 2) {
      await this.rpc("surfnet_writeProgram", [
        programId.toBase58(),
        hex.slice(offset, offset + PROGRAM_CHUNK_BYTES * 2),
        offset / 2,
      ]);
    }
  }

  async setProgramAuthority(programId: PublicKey, authority: PublicKey): Promise<void> {
    await this.rpc("surfnet_setProgramAuthority", [
      programId.toBase58(),
      authority.toBase58(),
    ]);
  }

  async airdrop(to: Keypair, lamports: number): Promise<void> {
    const pubkey = to.publicKey;
    const sig = await this.connection.requestAirdrop(pubkey, lamports);
    await confirmSignature(this.connection, sig);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    signalGroup("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      setTimeout(() => {
        if (child.exitCode === null) signalGroup("SIGKILL");
        resolve();
      }, 3_000);
    });
  }
}
