/**
 * JWS / DID verification utilities for Stoa receipt signatures.
 *
 * Uses `jose` for JWS operations and resolves vendor public keys
 * from `did:web` documents.
 */

import {
  compactVerify,
  importSPKI,
  importJWK,
  type KeyLike,
} from "jose";

export interface DidDocument {
  id: string;
  verificationMethod?: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyJwk?: Record<string, unknown>;
    publicKeyMultibase?: string;
  }>;
  assertionMethod?: string[];
}

/** Cache of resolved DID documents, keyed by DID */
const didCache = new Map<string, { doc: DidDocument; fetchedAt: number }>();
const DID_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve a `did:web` DID to its DID document.
 * Performs an HTTP GET to `https://<host>/.well-known/did.json`.
 * Caches the result for 5 minutes.
 */
export async function resolveDidWeb(did: string): Promise<DidDocument> {
  const now = Date.now();
  const cached = didCache.get(did);
  if (cached && now - cached.fetchedAt < DID_CACHE_TTL_MS) {
    return cached.doc;
  }

  if (!did.startsWith("did:web:")) {
    throw new Error(`Unsupported DID method: ${did}. Only did:web is supported.`);
  }

  const host = did.slice("did:web:".length);
  const url = `https://${host}/.well-known/did.json`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch DID document for ${did}: ${res.status} ${res.statusText}`);
  }
  const doc = (await res.json()) as DidDocument;
  didCache.set(did, { doc, fetchedAt: now });
  return doc;
}

/**
 * Extract the first verification key from a DID document and import it as a
 * `jose` KeyLike for use in signature verification.
 */
export async function getKeyFromDidDoc(doc: DidDocument): Promise<KeyLike> {
  const methods = doc.verificationMethod ?? [];
  if (methods.length === 0) {
    throw new Error(`DID document ${doc.id} has no verificationMethod entries`);
  }

  const first = methods[0];
  if (!first) {
    throw new Error(`DID document ${doc.id} has no verificationMethod entries`);
  }

  if (first.publicKeyJwk) {
    return importJWK(first.publicKeyJwk as Parameters<typeof importJWK>[0]);
  }

  if (first.publicKeyMultibase) {
    // Multibase-encoded SPKI — base58btc prefix 'z'
    if (!first.publicKeyMultibase.startsWith("z")) {
      throw new Error("Only base58btc multibase encoding is supported");
    }
    // For now surface a helpful error. Full multibase decode would use
    // the `multibase` package which we keep out of core deps.
    throw new Error(
      "publicKeyMultibase (base58btc) decoding requires the `multibase` package. " +
        "Use publicKeyJwk in the DID document instead."
    );
  }

  throw new Error(`Cannot extract key from verificationMethod in ${doc.id}`);
}

/**
 * Verify a compact JWS signature.
 *
 * @param jws - compact JWS string (header.payload.sig)
 * @param key - the public key to verify against
 * @returns the decoded payload as a Uint8Array
 */
export async function verifyJws(
  jws: string,
  key: KeyLike
): Promise<Uint8Array> {
  const result = await compactVerify(jws, key);
  return result.payload;
}

/**
 * Verify a Stoa receipt signature against the vendor's DID public key.
 *
 * The signed payload in a Stoa receipt is a detached-signature pattern:
 * the JWS covers (cap + ts + input_hash + output_hash + state_delta_hash + cost).
 * The sig field in the receipt is a compact JWS with detached payload.
 *
 * For v0.1, since we don't yet have real vendor JWS in the wild, this verifies
 * structural validity and DID resolution, and returns false with a reason string
 * when the signature cannot be cryptographically verified.
 */
export async function verifyReceiptSignature(
  receipt: {
    sig: string;
    vendor_did: string;
    alg: string;
    cap: string;
    ts: number;
    input_hash: string;
    output_hash: string;
    merkle_root: string;
  }
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const doc = await resolveDidWeb(receipt.vendor_did);
    const key = await getKeyFromDidDoc(doc);

    // Reconstruct the canonical signed payload
    const payload = JSON.stringify({
      cap: receipt.cap,
      ts: receipt.ts,
      input_hash: receipt.input_hash,
      output_hash: receipt.output_hash,
      merkle_root: receipt.merkle_root,
    });

    // Stoa uses detached payload JWS. Reconstruct as header..payload.sig
    // where payload is the base64url encoding of the canonical JSON.
    const payloadB64 = Buffer.from(payload).toString("base64url");
    const parts = receipt.sig.split(".");
    if (parts.length !== 3) {
      return { valid: false, reason: "Receipt sig is not a valid compact JWS" };
    }

    // Parts: [header, "", signature] for detached; reattach payload
    const reattached = `${parts[0]}.${payloadB64}.${parts[2]}`;

    await verifyJws(reattached, key);
    return { valid: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: msg };
  }
}

/**
 * Verify a compact JWT (e.g., agent-bearer).
 * Resolves the issuer's DID to fetch the public key, then verifies.
 */
export async function verifyAgentJwt(
  jwt: string,
  expectedAudience: string
): Promise<{ valid: boolean; payload?: Record<string, unknown>; reason?: string }> {
  try {
    // Decode header to get issuer DID (without verifying yet)
    const [headerB64] = jwt.split(".");
    if (!headerB64) throw new Error("Invalid JWT structure");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString()) as {
      alg?: string;
      kid?: string;
    };

    // Decode payload to get iss
    const parts = jwt.split(".");
    if (parts.length < 2) throw new Error("Invalid JWT: missing payload");
    const payloadPart = parts[1];
    if (!payloadPart) throw new Error("Invalid JWT: empty payload");
    const claims = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString()
    ) as Record<string, unknown>;

    if (typeof claims["iss"] !== "string") {
      return { valid: false, reason: "JWT missing iss claim" };
    }

    const doc = await resolveDidWeb(claims["iss"]);
    const key = await getKeyFromDidDoc(doc);

    const { compactVerify: _compactVerify } = await import("jose");
    const { payload } = await _compactVerify(jwt, key, {
      audience: expectedAudience,
    });
    const decoded = JSON.parse(Buffer.from(payload).toString()) as Record<string, unknown>;
    void header; // used implicitly
    return { valid: true, payload: decoded };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: msg };
  }
}
