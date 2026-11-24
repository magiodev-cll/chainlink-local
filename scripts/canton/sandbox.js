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

  const submit = async (commands, actAs, { disclosedContracts } = {}) => {
    const body = {
      commandId: crypto.randomUUID(),
      commands,
      userId: "participant_admin",
      actAs: [actAs],
      readAs: [],
    };
    if (disclosedContracts?.length) body.disclosedContracts = disclosedContracts;
    const res = await call("POST", "commands/submit-and-wait-for-transaction", { commands: body });
    return res.transaction.events.filter((e) => e.CreatedEvent).map((e) => e.CreatedEvent);
  };

  const create = async (templateId, createArguments, actAs, options) => {
    const [created] = await submit([{ CreateCommand: { templateId, createArguments } }], actAs, options);
    if (!created) throw new Error(`create ${templateId} produced no contract`);
    return created.contractId;
  };

  const exercise = (templateId, contractId, choice, choiceArgument, actAs, options) =>
    submit([{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }], actAs, options);

  return {
    version: () => call("GET", "version"),
    packages: async () => (await call("GET", "packages")).packageIds,
    parties: async () => (await call("GET", "parties")).partyDetails.map((p) => p.party),
    allocateParty: async (hint) => (await call("POST", "parties", { partyIdHint: hint })).partyDetails.party,
    submit,
    create,
    exercise,
    /** Active contracts visible to `party`, with the created-event blob needed to disclose them. */
    async activeContracts(party, templateId) {
      const { offset } = await call("GET", "state/ledger-end");
      const res = await call("POST", "state/active-contracts", {
        activeAtOffset: offset,
        filter: {
          filtersByParty: {
            [party]: {
              cumulative: [
                {
                  identifierFilter: {
                    TemplateFilter: { value: { templateId, includeCreatedEventBlob: true } },
                  },
                },
              ],
            },
          },
        },
        verbose: true,
      });
      return res.map((entry) => entry.contractEntry.JsActiveContract.createdEvent);
    },

    /** Every active contract the party can see. Only such a party can build disclosures. */
    async activeContractsWildcard(party) {
      const { offset } = await call("GET", "state/ledger-end");
      const res = await call("POST", "state/active-contracts", {
        activeAtOffset: offset,
        filter: {
          filtersByParty: {
            [party]: {
              cumulative: [
                { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: true } } } },
              ],
            },
          },
        },
        verbose: true,
      });
      return res.map((entry) => entry.contractEntry.JsActiveContract.createdEvent);
    },

    async synchronizerId() {
      const res = await call("GET", "state/connected-synchronizers");
      const first = res.connectedSynchronizers?.[0];
      if (!first) throw new Error("no connected synchronizer");
      return first.synchronizerId;
    },

    /** Exercise a choice and return its result, which is where the encoded message lives for `CCIPSend`. */
    exerciseResult: async (templateId, contractId, choice, choiceArgument, actAs, options = {}) => {
      const body = {
        commandId: crypto.randomUUID(),
        commands: [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }],
        userId: "participant_admin",
        actAs: [actAs],
        readAs: [],
      };
      if (options.disclosedContracts?.length) body.disclosedContracts = options.disclosedContracts;
      const res = await call("POST", "commands/submit-and-wait-for-transaction", { commands: body });
      const exercised = res.transaction.events
        .map((e) => e.ExercisedEvent)
        .find((e) => e && e.choice === choice && e.contractId === contractId);
      if (!exercised) throw new Error(`no exercise result for ${choice}`);
      return exercised.exerciseResult;
    },
  };
}

/** Daml variants encode as `{"tag": "Name", "value": ...}`; nullary constructors still need the key. */
export function variant(tag, value = {}) {
  return { tag, value };
}

/** Pre-attaches disclosed contracts to every submission, for parties that cannot see the CCIP contracts. */
export function withDisclosures(api, disclosedContracts) {
  if (!disclosedContracts?.length) return api;
  const options = { disclosedContracts };
  return {
    ...api,
    create: (templateId, createArguments, actAs) => api.create(templateId, createArguments, actAs, options),
    exercise: (templateId, contractId, choice, choiceArgument, actAs) =>
      api.exercise(templateId, contractId, choice, choiceArgument, actAs, options),
    exerciseResult: (templateId, contractId, choice, choiceArgument, actAs) =>
      api.exerciseResult(templateId, contractId, choice, choiceArgument, actAs, options),
  };
}

/** `Chainlink.InstanceAddress.RawInstanceAddress` is newtype `RawInstanceAddress Text`, encoded as `{"unpack": ...}`. */
export function instanceAddress(instanceId, party) {
  return { unpack: `${instanceId}@${party}` };
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
