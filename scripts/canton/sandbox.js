// A local Canton participant for CCIP experiments, using the `dpm sandbox` daemon from the Daml SDK.
// The sandbox serves the Ledger API as JSON on its own port, so the harness talks plain HTTP.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_DPM = path.join(os.homedir(), ".dpm", "bin", "dpm");

export function dpmPath() {
  return process.env.DPM_BIN ?? DEFAULT_DPM;
}

/**
 * Start a sandbox with the given DARs preloaded and resolve once it answers on the JSON API.
 * Ports come from `--canton-port-file`, because the daemon picks them and prints them late.
 */
export async function startSandbox({ dars = [], jsonApiPort, log = () => {}, timeoutMs = 180_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainlink-local-canton-"));
  const portFile = path.join(dir, "ports.json");
  const args = ["sandbox", "--no-tty", "--canton-port-file", portFile];
  if (jsonApiPort) args.push("--json-api-port", String(jsonApiPort));
  for (const dar of dars) args.push("--dar", dar);

  log(`starting sandbox${dars.length ? ` with ${dars.length} DARs` : ""}`);
  // Canton writes log/ and its H2 database into the working directory.
  // Detached so stop() can signal the whole group: dpm execs a JVM that outlives a plain kill().
  const child = spawn(dpmPath(), args, { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output = tail(output + d)));
  child.stderr.on("data", (d) => (output = tail(output + d)));

  let exitedEarly = false;
  const exited = new Promise((resolve) => {
    child.once("exit", () => {
      exitedEarly = true;
      resolve();
    });
    child.once("error", () => {
      exitedEarly = true;
      resolve();
    });
  });
  const deadline = Date.now() + timeoutMs;
  const alive = () => {
    if (exitedEarly) throw new Error("sandbox exited before it reported its ports");
  };

  try {
    const ports = await waitForPorts(portFile, deadline, alive);
    const url = `http://127.0.0.1:${ports.jsonApi}`;
    await waitForLedger(url, deadline, alive);
    return {
      url,
      ports,
      async stop() {
        killGroup(child, "SIGTERM");
        const timer = setTimeout(() => killGroup(child, "SIGKILL"), 10_000);
        await exited;
        clearTimeout(timer);
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw new Error(`${error.message}\n--- sandbox output ---\n${output}`);
  }
}

export function ledger(baseUrl) {
  const call = async (method, route, body) => {
    const res = await fetch(`${baseUrl}/v2/${route}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} /v2/${route} -> ${res.status} ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  };

  return {
    version: () => call("GET", "version"),
    packages: async () => (await call("GET", "packages")).packageIds,
    parties: async () => (await call("GET", "parties")).partyDetails.map((p) => p.party),
    allocateParty: async (hint) => (await call("POST", "parties", { partyIdHint: hint })).partyDetails.party,
    async create(templateId, createArguments, actAs) {
      const res = await call("POST", "commands/submit-and-wait", {
        commandId: crypto.randomUUID(),
        commands: [{ CreateCommand: { templateId, createArguments } }],
        userId: "participant_admin",
        actAs: [actAs],
        readAs: [],
      });
      return res.updateId;
    },
  };
}

/** Daml variants encode as `{"tag": "Name", "value": ...}`; nullary constructors still need the key. */
export function variant(tag, value = {}) {
  return { tag, value };
}

function tail(text, lines = 40) {
  return text.split("\n").slice(-lines).join("\n");
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

async function waitForPorts(portFile, deadline, alive = () => {}) {
  while (Date.now() < deadline) {
    alive();
    if (fs.existsSync(portFile)) {
      try {
        return JSON.parse(fs.readFileSync(portFile, "utf8")).sandbox;
      } catch {}
    }
    await sleep(500);
  }
  throw new Error("sandbox did not report its ports in time");
}

async function waitForLedger(url, deadline, alive = () => {}) {
  while (Date.now() < deadline) {
    alive();
    try {
      const res = await fetch(`${url}/v2/version`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`sandbox did not answer on ${url}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
