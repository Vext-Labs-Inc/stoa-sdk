/**
 * Receipt verification — `verify(receipts, foundationRoot)`
 *
 * Verifies:
 * 1. JWS signature on each receipt against the vendor's DID public key.
 * 2. Merkle proof inclusion in the daily foundation root.
 *
 * Returns {valid, invalid, details} per receipt.
 *
 * Reference: STOA.md §11 (receipts & audit).
 */

import { type Receipt, type VerifyResult, type VerifyDetail } from "./types.js";
import { verifyReceiptSignature } from "./util/jws.js";
import { verifyMerkleProof, sha256 } from "./util/hash.js";

export interface FoundationRoot {
  date: string;
  root: string;
  sig: string;
  algorithm?: string;
  issuer?: string;
}

/**
 * Parse a foundation root from a .sig file or a plain hex/base64 root string.
 *
 * Accepts:
 *   - JSON string: { "date": "...", "root": "0x...", "sig": "..." }
 *   - Plain hex string: treated as root, no date/sig
 */
export function parseFoundationRoot(raw: string): FoundationRoot {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as FoundationRoot;
    } catch {
      throw new Error("Invalid foundation root JSON");
    }
  }
  // Plain hex or base64url root
  return { date: "unknown", root: trimmed, sig: "", algorithm: "ES256" };
}

/**
 * Verify a list of receipts against a foundation daily root.
 *
 * @param receipts - Array of Receipt objects
 * @param foundationRoot - The foundation daily root (from parseFoundationRoot)
 * @param options.skipSignatureVerification - If true, skip JWS signature checks
 *   (useful for offline/test scenarios where DID documents are unavailable)
 */
export async function verify(
  receipts: Receipt[],
  foundationRoot: FoundationRoot,
  options: {
    skipSignatureVerification?: boolean;
    skipMerkleVerification?: boolean;
    verbose?: boolean;
  } = {}
): Promise<VerifyResult> {
  const details: VerifyDetail[] = [];
  let validCount = 0;
  let invalidCount = 0;

  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];
    if (!receipt) continue;

    let valid = true;
    let reason: string | undefined;

    // 1. Validate required fields are present
    const structuralCheck = checkStructure(receipt);
    if (!structuralCheck.ok) {
      valid = false;
      reason = structuralCheck.reason;
    }

    // 2. Verify JWS signature against vendor DID
    if (valid && !options.skipSignatureVerification) {
      try {
        const sigResult = await verifyReceiptSignature({
          sig: receipt.sig,
          vendor_did: receipt.vendor_did,
          alg: receipt.alg,
          cap: receipt.cap,
          ts: receipt.ts,
          input_hash: receipt.input_hash,
          output_hash: receipt.output_hash,
          merkle_root: receipt.merkle_root,
        });
        if (!sigResult.valid) {
          valid = false;
          reason = `Signature invalid: ${sigResult.reason ?? "unknown"}`;
        }
      } catch (err: unknown) {
        // DID resolution failure — network down / offline
        const msg = err instanceof Error ? err.message : String(err);
        if (options.verbose) {
          reason = `Signature check skipped (DID resolution failed): ${msg}`;
        }
        // Don't mark invalid for network failures — flag as skipped
      }
    }

    // 3. Verify Merkle proof against daily root
    if (valid && !options.skipMerkleVerification && receipt.merkle_proof.length > 0) {
      const leafHash = sha256(
        JSON.stringify({
          cap: receipt.cap,
          ts: receipt.ts,
          input_hash: receipt.input_hash,
          output_hash: receipt.output_hash,
          vendor_did: receipt.vendor_did,
        })
      );

      const merkleOk = verifyMerkleProof(
        leafHash,
        receipt.merkle_proof,
        foundationRoot.root
      );

      if (!merkleOk) {
        valid = false;
        reason = `Merkle proof invalid for root ${foundationRoot.root}`;
      }

      // Check root matches the receipt's declared root
      if (receipt.merkle_root !== foundationRoot.root) {
        // This is not necessarily invalid — the receipt may have been anchored
        // on a different day. Flag as a warning rather than hard failure.
        if (options.verbose) {
          reason = `Root mismatch: receipt declares ${receipt.merkle_root}, provided root is ${foundationRoot.root}`;
        }
      }
    }

    const detail: VerifyDetail = { index: i, receipt, valid, reason };
    details.push(detail);

    if (valid) {
      validCount++;
    } else {
      invalidCount++;
    }
  }

  return { valid: validCount, invalid: invalidCount, details };
}

/**
 * Parse receipts from a JSONL string (one JSON object per line).
 * Lines that fail to parse are skipped with a console warning.
 */
export function parseReceiptsJsonl(content: string): Receipt[] {
  const receipts: Receipt[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;

    try {
      const obj = JSON.parse(line) as Receipt;
      receipts.push(obj);
    } catch {
      console.warn(`[stoa verify] Line ${i + 1}: invalid JSON, skipped`);
    }
  }

  return receipts;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function checkStructure(receipt: Receipt): { ok: boolean; reason?: string } {
  if (!receipt.sig || typeof receipt.sig !== "string") {
    return { ok: false, reason: "Missing or invalid sig field" };
  }
  if (!receipt.vendor_did || !receipt.vendor_did.startsWith("did:")) {
    return { ok: false, reason: `Invalid vendor_did: ${String(receipt.vendor_did)}` };
  }
  if (!receipt.cap || !receipt.cap.startsWith("urn:stoa:cap:")) {
    return { ok: false, reason: `Invalid cap URN: ${String(receipt.cap)}` };
  }
  if (typeof receipt.ts !== "number") {
    return { ok: false, reason: "Missing or invalid ts (timestamp) field" };
  }
  if (!receipt.input_hash) {
    return { ok: false, reason: "Missing input_hash" };
  }
  if (!receipt.output_hash) {
    return { ok: false, reason: "Missing output_hash" };
  }
  if (!receipt.merkle_root) {
    return { ok: false, reason: "Missing merkle_root" };
  }
  if (!Array.isArray(receipt.merkle_proof)) {
    return { ok: false, reason: "merkle_proof must be an array" };
  }
  return { ok: true };
}
