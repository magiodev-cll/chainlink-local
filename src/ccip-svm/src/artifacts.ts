import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Pinned CCIP 2.0 Solana artifacts.
 *
 * `chainlink-ccip-solana` publishes a rolling `latest` prerelease. The digest below pins the
 * exact bytes this package was validated against; a mismatch fails loudly instead of silently
 * drifting into a new program version.
 */
export const ARTIFACTS = {
  version: "2.0.0-latest+b9ee948",
  url: "https://github.com/smartcontractkit/chainlink-ccip-solana/releases/download/latest/artifacts.tar.gz",
  sha256: "29ea1705b5c06181f326886ac67feee10e327a94fb02e3509b624501c1a0fdbc",
} as const;

function cacheRoot(): string {
  return process.env.CCIP_SVM_CACHE ?? path.join(os.homedir(), ".cache", "chainlink-local-svm");
}

/** Path to an already-extracted artifact bundle, or undefined if it must be fetched. */
function existingBundle(dir: string): string | undefined {
  const deploy = path.join(dir, "target", "deploy");
  const idl = path.join(dir, "target", "idl");
  if (fs.existsSync(deploy) && fs.existsSync(idl)) return dir;
  return undefined;
}

/**
 * Resolve the artifact directory, downloading and verifying on first use.
 *
 * Set `CCIP_SVM_ARTIFACTS` to point at an extracted `target/` bundle to skip the network.
 */
export async function resolveArtifacts(): Promise<string> {
  const override = process.env.CCIP_SVM_ARTIFACTS;
  if (override) {
    const bundle = existingBundle(override);
    if (!bundle) throw new Error(`CCIP_SVM_ARTIFACTS does not contain target/deploy: ${override}`);
    return bundle;
  }

  const root = cacheRoot();
  const bundleDir = path.join(root, `artifacts-${ARTIFACTS.version}`);
  const ready = existingBundle(bundleDir);
  if (ready) return ready;

  fs.mkdirSync(root, { recursive: true });
  const tarball = path.join(root, `artifacts-${ARTIFACTS.version}.tar.gz`);
  if (!fs.existsSync(tarball)) {
    const res = await fetch(ARTIFACTS.url);
    if (!res.ok) throw new Error(`failed to download CCIP Solana artifacts: ${res.status}`);
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  }

  const digest = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  if (digest !== ARTIFACTS.sha256) {
    throw new Error(
      `CCIP Solana artifact digest mismatch: expected ${ARTIFACTS.sha256}, got ${digest}. ` +
        `The upstream 'latest' release moved; pin a new digest before using it.`,
    );
  }

  fs.mkdirSync(bundleDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", bundleDir], { stdio: "ignore" });
  const bundle = existingBundle(bundleDir);
  if (!bundle) throw new Error("artifact bundle did not contain target/deploy");
  return bundle;
}

export function readIdl(bundleDir: string, name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(bundleDir, "target", "idl", `${name}.json`), "utf8"));
}

export function readProgram(bundleDir: string, name: string): Buffer {
  return fs.readFileSync(path.join(bundleDir, "target", "deploy", `${name}.so`));
}
