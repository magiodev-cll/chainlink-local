// Local committee keys and the verifierResults blob, ported from `CommitteeVerifierV2`.
// Signatures are raw r || s; the verifier checks ECDSA against uncompressed secp256k1 keys.

import { SigningKey, concat, getBytes, hexlify, keccak256 } from "ethers";

/** Deterministic committee key, so a fixture is reproducible across runs. */
export function committeeKey(seed = 0) {
  return getBytes(keccak256(Buffer.from(`chainlink-local-canton:${seed}`, "utf8")));
}

/** Uncompressed `04...` public key, which is what `ApplySignatureConfigs` expects. */
export function publicKeyOf(privateKey) {
  return new SigningKey(privateKey).publicKey.toLowerCase().replace(/^0x/, "");
}

/** `keccak256(versionTag || messageId)`, the hash every signer signs. */
export function signedHash(messageId, versionTag) {
  return keccak256(concat([getBytes(`0x${versionTag}`), getBytes(messageId)]));
}

/** `versionTag || u16 BE total length || r||s || r||s ...` */
export function verifierResults(messageId, privateKeys, versionTag) {
  const hash = signedHash(messageId, versionTag);
  const signatures = privateKeys.map((key) => {
    const { r, s } = new SigningKey(key).sign(hash);
    return `${r.slice(2)}${s.slice(2)}`;
  });
  const body = hexlify(concat(signatures.map((sig) => getBytes(`0x${sig}`)))).slice(2);
  const length = body.length / 2;
  return `${versionTag}${length.toString(16).padStart(4, "0")}${body}`;
}
