// Proves the Canton half of a future `@chainlink/local/canton`: the real CCIP Daml contracts run on a
// local participant, and a receiver can be created by a test party. Nothing here simulates CCIP yet.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { listDars, resolveArtifacts } from "./artifacts.js";
import { dpmPath, ledger, startSandbox, variant } from "./sandbox.js";

// Pinned by the release digest in artifacts.js; the module is `CCIP.CCIPReceiver`.
const CCIP_RECEIVER_PACKAGE = "95c3cdc53c172c7202f5b2711ad01d591c84e0aa00cbce4fd0d9ad8f75c11552";

const log = (line) => console.log(`[canton] ${line}`);

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  requireToolchain();

  const dir = resolveArtifacts({ log });
  const dars = listDars(dir);
  log(`${dars.length} CCIP DARs from the pinned release`);

  const sandbox = await startSandbox({ dars, log });
  log(`sandbox up: ledger API ${sandbox.ports.ledgerApi}, JSON API ${sandbox.ports.jsonApi}`);

  try {
    const api = ledger(sandbox.url);

    // The sandbox reports ready before it finishes loading DARs, so poll for the package we need.
    const packages = await waitForPackage(api, CCIP_RECEIVER_PACKAGE);
    log(`packages on ledger: ${packages.length}, including CCIP.CCIPReceiver`);

    const alice = await api.allocateParty("alice");
    log(`party: ${alice}`);

    const updateId = await api.create(
      `${CCIP_RECEIVER_PACKAGE}:CCIP.CCIPReceiver:CCIPReceiver`,
      {
        instanceId: "local-receiver",
        owner: alice,
        requiredCCVs: [],
        optionalCCVs: [],
        optionalThreshold: 0,
        receiverFinalityConfig: variant("WaitForSafe"),
      },
      alice,
    );
    log(`created CCIP.CCIPReceiver, update ${updateId}`);

    console.log("\nPASS: real CCIP contracts live on a local Canton participant.");
  } finally {
    await sandbox.stop();
  }
}

function requireToolchain() {
  if (!fs.existsSync(dpmPath())) {
    throw new Error(
      `dpm not found at ${dpmPath()}. Install the Daml SDK:\n` +
        `  brew install openjdk@17\n` +
        `  curl -sSL https://github.com/digital-asset/dpm/releases/download/1.1.3/dpm-1.1.3-darwin-arm64.tar.gz | tar xz -C ~/.local/bin\n` +
        `  dpm install 3.4.11`,
    );
  }
  try {
    execFileSync(process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/java` : "java", ["-version"], {
      stdio: "ignore",
    });
  } catch {
    throw new Error(`Java 17 required. brew install openjdk@17 && export JAVA_HOME=/opt/homebrew/opt/openjdk@17`);
  }
}

async function waitForPackage(api, packageId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const packages = await api.packages();
    if (packages.includes(packageId)) return packages;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`package ${packageId} did not load within ${timeoutMs}ms`);
}
