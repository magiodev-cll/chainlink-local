// Proves the Canton half of a future `@chainlink/local/canton`: the real CCIP Daml contracts run on a
// local participant, and a receiver can be created by a test party. Nothing here simulates CCIP yet.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { listDars, resolveArtifacts } from "./artifacts.js";
import { bootstrap, PACKAGES, RECEIVER } from "./bootstrap.js";
import { dpmPath, ledger, startSandbox, variant } from "./sandbox.js";

// `canton-localnet`, per chain-selectors. The local participant plays this chain.
const CANTON_LOCALNET_SELECTOR = "8706591216959472610";

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
    const packages = await waitForPackage(api, PACKAGES.factory);
    log(`packages on ledger: ${packages.length}, including CCIP.FactoryV2`);

    const alice = await api.allocateParty("alice");
    log(`party: ${alice}`);

    const { addresses, deployed, router } = await bootstrap({
      api,
      owner: alice,
      chainSelector: CANTON_LOCALNET_SELECTOR,
      log,
    });
    log(`${Object.keys(deployed).length} CCIP contracts deployed`);

    const receiver = await api.create(
      RECEIVER,
      {
        instanceId: "chainlink-local-receiver",
        owner: alice,
        requiredCCVs: [],
        optionalCCVs: [],
        optionalThreshold: 0,
        receiverFinalityConfig: variant("WaitForSafe"),
      },
      alice,
    );
    log(`CCIPReceiver: ${receiver.slice(0, 16)}...`);
    log(`router: ${router.slice(0, 16)}... at ${addresses.routerFactory.unpack}`);

    console.log("\nPASS: CCIP 2.0 trust layer deployed on a local Canton participant.");
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
