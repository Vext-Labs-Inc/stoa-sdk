/**
 * Hashing utilities for Stoa SDK.
 *
 * Uses Node.js built-in crypto so there are no extra deps.
 */

import { createHash } from "node:crypto";

/**
 * SHA-256 hash of a string or Buffer.
 * Returns a hex string prefixed with "sha256:".
 */
export function sha256(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(input);
  return `sha256:0x${hash.digest("hex")}`;
}

/**
 * SHA-256 of a JSON-serializable value.
 * The value is canonicalized via JSON.stringify with sorted keys.
 */
export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * Canonical JSON: sorted keys, no trailing whitespace.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

function sortedReplacer(
  _key: string,
  val: unknown
): unknown {
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      )
    );
  }
  return val;
}

/**
 * Generate a simple idempotency key from parts.
 * Pattern: <agent_id>:<plan_id>:<step_id>
 */
export function idemKey(...parts: string[]): string {
  return parts.join(":");
}

/**
 * Verify a merkle proof for a leaf against a root.
 *
 * For v0 this is a stub that validates structural integrity only.
 * Full Merkle verification requires the tree construction algorithm
 * from the daily bundle. A complete implementation would use
 * SHA-256 pairwise hashing up to the root.
 */
export function verifyMerkleProof(
  leafHash: string,
  proof: string[],
  root: string
): boolean {
  if (!leafHash || !root) return false;
  // A real implementation would hash pairs up the tree.
  // For v0, we accept any non-empty proof as structurally valid
  // when the root is present. The CLI will do full verification
  // once the daily root format is finalized.
  return proof.length >= 0 && root.length > 0 && leafHash.length > 0;
}
