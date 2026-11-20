// Pinned CCIP Daml contracts, fetched from the upstream `chainlink-canton` release.
// The release asset is immutable, so the digest guards a corrupt download rather than a moving tag.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ARTIFACTS = {
  release: "contracts/v2.3.0",
  url: "https://github.com/smartcontractkit/chainlink-canton/releases/download/contracts/v2.3.0/chainlink-ccip-v2.3.0.zip",
  sha256: "e4bb61b91f95508031e9f3deb05bc860c7f2956965656b54e113f058c10eb1e1",
};

export function defaultCacheDir() {
  return path.join(os.homedir(), ".cache", "chainlink-local", "canton");
}

/** Directory holding the unpacked `.dar` files, downloaded and verified on first use. */
export function resolveArtifacts({ cacheDir = defaultCacheDir(), log = () => {} } = {}) {
  const root = path.join(cacheDir, ARTIFACTS.release.replace(/[^A-Za-z0-9.]+/g, "-"));
  const dars = path.join(root, "dars");
  if (hasDars(dars)) return dars;

  fs.mkdirSync(dars, { recursive: true });
  const zip = path.join(root, "artifacts.zip");
  if (!fs.existsSync(zip)) {
    log(`downloading ${ARTIFACTS.release}`);
    execFileSync("curl", ["-sSL", "-o", zip, ARTIFACTS.url]);
  }

  const digest = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  if (digest !== ARTIFACTS.sha256) {
    throw new Error(
      `CCIP Canton artifact digest mismatch: expected ${ARTIFACTS.sha256}, got ${digest}. ` +
        `Delete ${zip} and retry; if it repeats, the release asset changed.`,
    );
  }

  execFileSync("unzip", ["-oq", zip, "-d", dars]);
  return dars;
}

/** Absolute paths, because every caller feeds them to `dpm sandbox --dar`. */
export function listDars(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".dar"))
    .sort()
    .map((f) => path.join(dir, f));
}

function hasDars(dir) {
  return fs.existsSync(dir) && listDars(dir).length > 0;
}
