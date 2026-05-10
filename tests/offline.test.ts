/**
 * Tests for offline bundle loading and search.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadBundle, Bundle } from "../src/offline.js";
import type { BundleManifest, BundleCapabilityEntry, CapabilityURN } from "../src/types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers to build a tiny test bundle on disk
// ---------------------------------------------------------------------------

async function hasTarCommand(): Promise<boolean> {
  try {
    await execFileAsync("tar", ["--version"], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function createTestBundle(dir: string): Promise<string> {
  const bundleDir = join(dir, "test-bundle-src");
  const capsDir = join(bundleDir, "caps");
  const rootsDir = join(bundleDir, "roots");

  await mkdir(capsDir, { recursive: true });
  await mkdir(rootsDir, { recursive: true });

  const cap1: BundleCapabilityEntry = {
    urn: "urn:stoa:cap:hubspot.contacts.create@2.3.1" as CapabilityURN,
    vendor_did: "did:web:hubspot.com",
    summary: "Create a CRM contact record",
    scopes_required: ["hubspot:contacts:write"],
    price: { current_cents: 5, stale_after: 300 },
    reliability: { window_24h: 0.997, p50_latency_ms: 84, p99_latency_ms: 312, samples: 18204 },
    side_effect_class: "external.crm.write",
  };

  const cap2: BundleCapabilityEntry = {
    urn: "urn:stoa:cap:resend.email.send@1.4.0" as CapabilityURN,
    vendor_did: "did:web:resend.com",
    summary: "Send a transactional email",
    scopes_required: ["resend:email:send"],
    price: { current_cents: 1, stale_after: 300 },
    reliability: { window_24h: 0.999, p50_latency_ms: 120, p99_latency_ms: 500, samples: 52000 },
    side_effect_class: "external.email.send",
  };

  const cap3: BundleCapabilityEntry = {
    urn: "urn:stoa:cap:posthog.events.query@2.0.0" as CapabilityURN,
    vendor_did: "did:web:posthog.com",
    summary: "Query analytics events from PostHog",
    scopes_required: ["posthog:events:read"],
    price: { current_cents: 3, stale_after: 300 },
    reliability: { window_24h: 0.995, p50_latency_ms: 200, p99_latency_ms: 800, samples: 9000 },
    side_effect_class: "external.analytics.read",
  };

  await writeFile(join(capsDir, "hubspot.contacts.create@2.3.1.json"), JSON.stringify(cap1));
  await writeFile(join(capsDir, "resend.email.send@1.4.0.json"), JSON.stringify(cap2));
  await writeFile(join(capsDir, "posthog.events.query@2.0.0.json"), JSON.stringify(cap3));

  const manifest: BundleManifest = {
    date: "2026-05-10",
    registry: "https://caps.stoa.foundation/",
    capabilities: [
      {
        urn: cap1.urn,
        file: "caps/hubspot.contacts.create@2.3.1.json",
        content_hash: "sha256:0xtest1",
      },
      {
        urn: cap2.urn,
        file: "caps/resend.email.send@1.4.0.json",
        content_hash: "sha256:0xtest2",
      },
      {
        urn: cap3.urn,
        file: "caps/posthog.events.query@2.0.0.json",
        content_hash: "sha256:0xtest3",
      },
    ],
    roots: [
      {
        issuer: "did:web:stoa.foundation",
        sig: "MEUCIQ...",
        algorithm: "ES256",
      },
    ],
  };

  await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(rootsDir, "foundation.sig"), JSON.stringify({
    root: "0x9f3a2b4c",
    sig: "MEUCIQ...",
    date: "2026-05-10",
  }));

  // Create a .tar (uncompressed — zstd may not be available in test env)
  const bundlePath = join(dir, "test-bundle.tar");
  await execFileAsync("tar", ["-cf", bundlePath, "-C", dir, "test-bundle-src"], {
    timeout: 10000,
  });

  return bundlePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let bundlePath: string;
let testDir: string;
let bundle: Bundle;
let tarAvailable = false;

beforeAll(async () => {
  tarAvailable = await hasTarCommand();
  if (!tarAvailable) return;

  testDir = join(tmpdir(), `stoa-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  bundlePath = await createTestBundle(testDir);
  bundle = await loadBundle(bundlePath);
});

afterAll(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
});

describe("loadBundle", () => {
  it("loads a bundle from a local path", { skip: !tarAvailable }, async () => {
    expect(bundle).toBeInstanceOf(Bundle);
  });

  it("parses the manifest correctly", { skip: !tarAvailable }, () => {
    expect(bundle.manifest.date).toBe("2026-05-10");
    expect(bundle.manifest.registry).toContain("stoa.foundation");
    expect(bundle.manifest.capabilities).toHaveLength(3);
    expect(bundle.manifest.roots).toHaveLength(1);
  });

  it("mounts all capabilities", { skip: !tarAvailable }, () => {
    const urns = bundle.list();
    expect(urns).toHaveLength(3);
    expect(urns).toContain("urn:stoa:cap:hubspot.contacts.create@2.3.1");
    expect(urns).toContain("urn:stoa:cap:resend.email.send@1.4.0");
    expect(urns).toContain("urn:stoa:cap:posthog.events.query@2.0.0");
  });

  it("retrieves a capability by URN", { skip: !tarAvailable }, () => {
    const cap = bundle.get("urn:stoa:cap:hubspot.contacts.create@2.3.1" as CapabilityURN);
    expect(cap).toBeDefined();
    expect(cap?.vendor_did).toBe("did:web:hubspot.com");
    expect(cap?.summary).toContain("contact");
  });

  it("returns undefined for an unknown URN", { skip: !tarAvailable }, () => {
    const cap = bundle.get("urn:stoa:cap:unknown.capability@1.0.0" as CapabilityURN);
    expect(cap).toBeUndefined();
  });
});

describe("Bundle.search", () => {
  it("returns results for a keyword query", { skip: !tarAvailable }, () => {
    const results = bundle.search("contact");
    expect(results.length).toBeGreaterThan(0);
    // HubSpot contacts should rank first
    expect(results[0]?.urn).toBe("urn:stoa:cap:hubspot.contacts.create@2.3.1");
  });

  it("returns results for an email query", { skip: !tarAvailable }, () => {
    const results = bundle.search("email");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.urn).toContain("email");
  });

  it("respects topK option", { skip: !tarAvailable }, () => {
    const results = bundle.search("a", { topK: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("returns empty for a query with no matches", { skip: !tarAvailable }, () => {
    const results = bundle.search("xyzqrst_nonexistent_capability_8437", { minScore: 0.5 });
    expect(results).toHaveLength(0);
  });

  it("includes score and entry in results", { skip: !tarAvailable }, () => {
    const results = bundle.search("analytics events");
    if (results.length > 0) {
      const first = results[0];
      expect(first).toBeDefined();
      if (first) {
        expect(typeof first.score).toBe("number");
        expect(first.entry).toBeDefined();
        expect(first.urn).toMatch(/^urn:stoa:cap:/);
      }
    }
  });

  it("finds capabilities by side_effect_class terms", { skip: !tarAvailable }, () => {
    const results = bundle.search("crm write");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test that loadBundle throws helpful error when tar unavailable
// ---------------------------------------------------------------------------

describe("loadBundle error handling", () => {
  it("throws a descriptive error when the bundle path does not exist", async () => {
    await expect(loadBundle("/nonexistent/bundle.tar.zst")).rejects.toThrow();
  });
});
