/**
 * Tests for receipt verification.
 */

import { describe, it, expect, vi } from "vitest";
import { verify, parseReceiptsJsonl, parseFoundationRoot } from "../src/verify.js";
import type { Receipt } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture: known valid receipt structure
// ---------------------------------------------------------------------------

const FOUNDATION_ROOT = {
  date: "2026-05-10",
  root: "0x9f3a2b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2",
  sig: "MEUCIQ...",
  algorithm: "ES256",
  issuer: "did:web:stoa.foundation",
};

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    alg: "ES256",
    sig: "MEUCIQDtest.payload.signature",
    vendor_did: "did:web:hubspot.com",
    ts: 1715212345,
    cap: "urn:stoa:cap:hubspot.contacts.create@2.3.1",
    input_hash: "sha256:0xabcdef1234",
    output_hash: "sha256:0xcdef12345678",
    merkle_root: FOUNDATION_ROOT.root,
    merkle_proof: ["0xabc", "0xdef"],
    cost_actual_cents: 8,
    trace_id: "trc_01HK...",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseFoundationRoot
// ---------------------------------------------------------------------------

describe("parseFoundationRoot", () => {
  it("parses a JSON root string", () => {
    const raw = JSON.stringify(FOUNDATION_ROOT);
    const parsed = parseFoundationRoot(raw);
    expect(parsed.root).toBe(FOUNDATION_ROOT.root);
    expect(parsed.date).toBe("2026-05-10");
  });

  it("parses a plain hex root string", () => {
    const root = "0x9f3a2b4c5d6e7f8a";
    const parsed = parseFoundationRoot(root);
    expect(parsed.root).toBe(root);
    expect(parsed.date).toBe("unknown");
  });

  it("throws on invalid JSON root", () => {
    expect(() => parseFoundationRoot("{invalid json}")).toThrow(/Invalid foundation root/);
  });
});

// ---------------------------------------------------------------------------
// parseReceiptsJsonl
// ---------------------------------------------------------------------------

describe("parseReceiptsJsonl", () => {
  it("parses a single receipt from JSONL", () => {
    const receipt = makeReceipt();
    const jsonl = JSON.stringify(receipt);
    const parsed = parseReceiptsJsonl(jsonl);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.cap).toBe("urn:stoa:cap:hubspot.contacts.create@2.3.1");
  });

  it("parses multiple receipts from JSONL", () => {
    const r1 = makeReceipt({ trace_id: "trc_001" });
    const r2 = makeReceipt({ trace_id: "trc_002" });
    const jsonl = [JSON.stringify(r1), JSON.stringify(r2)].join("\n");
    const parsed = parseReceiptsJsonl(jsonl);
    expect(parsed).toHaveLength(2);
  });

  it("skips empty lines and comment lines", () => {
    const receipt = makeReceipt();
    const jsonl = `
// This is a comment
# Another comment

${JSON.stringify(receipt)}

`;
    const parsed = parseReceiptsJsonl(jsonl);
    expect(parsed).toHaveLength(1);
  });

  it("skips invalid JSON lines with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const jsonl = `{invalid json}\n${JSON.stringify(makeReceipt())}`;
    const parsed = parseReceiptsJsonl(jsonl);
    expect(parsed).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("invalid JSON"));
    warnSpy.mockRestore();
  });

  it("returns empty array for empty content", () => {
    expect(parseReceiptsJsonl("")).toHaveLength(0);
    expect(parseReceiptsJsonl("   \n  \n  ")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// verify — structural validation
// ---------------------------------------------------------------------------

describe("verify — structural validation", () => {
  it("passes a valid receipt (signature skipped, merkle skipped)", async () => {
    const receipt = makeReceipt();
    const result = await verify([receipt], FOUNDATION_ROOT, {
      skipSignatureVerification: true,
      skipMerkleVerification: true,
    });
    expect(result.valid).toBe(1);
    expect(result.invalid).toBe(0);
  });

  it("fails a receipt with missing sig", async () => {
    const receipt = makeReceipt({ sig: "" });
    const result = await verify([receipt], FOUNDATION_ROOT, {
      skipSignatureVerification: true,
      skipMerkleVerification: true,
    });
    expect(result.invalid).toBe(1);
    expect(result.details[0]?.reason).toMatch(/sig/);
  });

  it("fails a receipt with invalid vendor_did", async () => {
    const receipt = makeReceipt({ vendor_did: "not-a-did" });
    const result = await verify([receipt], FOUNDATION_ROOT, {
      skipSignatureVerification: true,
      skipMerkleVerification: true,
    });
    expect(result.invalid).toBe(1);
    expect(result.details[0]?.reason).toMatch(/vendor_did/);
  });

  it("fails a receipt with invalid cap URN", async () => {
    const receipt = makeReceipt({ cap: "not:a:stoa:cap" as typeof receipt.cap });
    const result = await verify([receipt], FOUNDATION_ROOT, {
      skipSignatureVerification: true,
      skipMerkleVerification: true,
    });
    expect(result.invalid).toBe(1);
    expect(result.details[0]?.reason).toMatch(/cap URN/);
  });

  it("fails a receipt with missing input_hash", async () => {
    const receipt = makeReceipt({ input_hash: "" });
    const result = await verify([receipt], FOUNDATION_ROOT, {
      skipSignatureVerification: true,
      skipMerkleVerification: true,
    });
    expect(result.invalid).toBe(1);
    expect(result.details[0]?.reason).toMatch(/input_hash/);
  });

  it("fails a receipt with missing ts", async () => {
    // @ts-expect-error intentional bad value for test
    const receipt = makeReceipt({ ts: "not-a-number" });
    const result = await verify([receipt], FOUNDATION_ROOT, {
      skipSignatureVerification: true,
      skipMerkleVerification: true,
    });
    expect(result.invalid).toBe(1);
  });

  it("verifies multiple receipts and returns correct counts", async () => {
    const validReceipt = makeReceipt();
    const invalidReceipt = makeReceipt({ sig: "" });
    const result = await verify([validReceipt, validReceipt, invalidReceipt], FOUNDATION_ROOT, {
      skipSignatureVerification: true,
      skipMerkleVerification: true,
    });
    expect(result.valid).toBe(2);
    expect(result.invalid).toBe(1);
    expect(result.details).toHaveLength(3);
  });

  it("returns correct detail indices", async () => {
    const receipts = [makeReceipt(), makeReceipt(), makeReceipt()];
    const result = await verify(receipts, FOUNDATION_ROOT, {
      skipSignatureVerification: true,
      skipMerkleVerification: true,
    });
    result.details.forEach((d, i) => {
      expect(d.index).toBe(i);
    });
  });
});

// ---------------------------------------------------------------------------
// verify — Merkle proof checks
// ---------------------------------------------------------------------------

describe("verify — Merkle proof", () => {
  it("accepts a receipt when merkle_proof is an empty array (no proof available)", async () => {
    const receipt = makeReceipt({ merkle_proof: [] });
    const result = await verify([receipt], FOUNDATION_ROOT, {
      skipSignatureVerification: true,
      // Don't skip merkle — empty proof with no verification still passes
    });
    // Empty proof should not fail (proof not yet anchored)
    expect(result.invalid).toBe(0);
  });

  it("fails a receipt when merkle_proof is missing (not an array)", async () => {
    // @ts-expect-error intentional bad value
    const receipt = makeReceipt({ merkle_proof: null });
    const result = await verify([receipt], FOUNDATION_ROOT, {
      skipSignatureVerification: true,
    });
    expect(result.invalid).toBe(1);
    expect(result.details[0]?.reason).toMatch(/merkle_proof/);
  });
});
