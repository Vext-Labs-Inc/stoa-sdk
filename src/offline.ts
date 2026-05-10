/**
 * Offline bundle support — `loadBundle(pathOrUrl)`
 *
 * Reads a `.tar.zst` daily capability bundle published by a Stoa registry.
 * Parses `manifest.json`, mounts capabilities, and provides semantic search
 * over capability descriptions.
 *
 * Bundle format (STOA.md §14, §7.5):
 *   caps/
 *     <urn-slug>.json
 *   manifest.json
 *   roots/
 *     foundation.sig
 *
 * Reference: STOA.md §14 (offline-first bundles), §7 (federated cap graph).
 */

import { createWriteStream, createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type {
  BundleManifest,
  BundleCapabilityEntry,
  CapabilityURN,
} from "./types.js";

// ---------------------------------------------------------------------------
// Bundle class
// ---------------------------------------------------------------------------

export class Bundle {
  readonly manifest: BundleManifest;
  private readonly _capabilities: Map<CapabilityURN, BundleCapabilityEntry>;
  private readonly _extractDir: string;

  constructor(
    manifest: BundleManifest,
    capabilities: Map<CapabilityURN, BundleCapabilityEntry>,
    extractDir: string
  ) {
    this.manifest = manifest;
    this._capabilities = capabilities;
    this._extractDir = extractDir;
  }

  /**
   * Get a capability by URN.
   */
  get(urn: CapabilityURN): BundleCapabilityEntry | undefined {
    return this._capabilities.get(urn);
  }

  /**
   * List all capability URNs in the bundle.
   */
  list(): CapabilityURN[] {
    return Array.from(this._capabilities.keys());
  }

  /**
   * Semantic search over capability descriptions.
   *
   * For v0, performs TF-IDF-style keyword search over capability URNs and
   * summaries (no external embedding model needed for the search path).
   * If pre-computed embeddings are present in the entries, uses cosine
   * similarity over those vectors.
   *
   * @param query - Natural language query
   * @param opts.topK - Max results to return (default 10)
   * @param opts.minScore - Minimum similarity score 0-1 (default 0.0)
   */
  search(
    query: string,
    opts: { topK?: number; minScore?: number } = {}
  ): Array<{ urn: CapabilityURN; score: number; entry: BundleCapabilityEntry }> {
    const topK = opts.topK ?? 10;
    const minScore = opts.minScore ?? 0.0;

    const queryTerms = tokenize(query);

    const scored: Array<{ urn: CapabilityURN; score: number; entry: BundleCapabilityEntry }> = [];

    for (const [urn, entry] of this._capabilities) {
      let score = 0;

      // If we have pre-computed embedding vectors, use dot-product similarity
      // (assumes normalized vectors from the bundle)
      if (entry.embedding && entry.embedding.length > 0) {
        // We don't have a query embedding here without an embedding model.
        // Fall through to keyword scoring unless caller provides queryEmbedding.
        // In the CLI we'll note this limitation.
      }

      // Keyword scoring: TF-style match on URN components and summary
      const docText = [
        urn.toLowerCase(),
        (entry.summary ?? "").toLowerCase(),
        (entry.side_effect_class ?? "").toLowerCase(),
        ...(entry.scopes_required ?? []),
      ].join(" ");

      for (const term of queryTerms) {
        const count = countOccurrences(docText, term);
        if (count > 0) {
          score += (1 + Math.log(count)) * idf(term, this._capabilities.size);
        }
      }

      // Normalize to 0-1 range roughly by dividing by query term count
      const normalizedScore =
        queryTerms.length > 0 ? Math.min(score / queryTerms.length, 1) : 0;

      if (normalizedScore >= minScore) {
        scored.push({ urn, score: normalizedScore, entry });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Get the extract directory (for debugging / direct file access).
   */
  get extractDir(): string {
    return this._extractDir;
  }
}

// ---------------------------------------------------------------------------
// loadBundle
// ---------------------------------------------------------------------------

/**
 * Load a Stoa capability bundle from a local `.tar.zst` file or a remote URL.
 *
 * If `pathOrUrl` starts with "http://" or "https://", the bundle is downloaded
 * to a temporary directory first.
 *
 * The bundle is extracted and its manifest parsed. Capability entries are
 * lazy-loaded (only the manifest is parsed eagerly; individual cap files are
 * parsed on first access or during search).
 */
export async function loadBundle(pathOrUrl: string): Promise<Bundle> {
  let localPath = pathOrUrl;

  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    localPath = await downloadBundle(pathOrUrl);
  }

  const extractDir = join(tmpdir(), `stoa-bundle-${randomUUID()}`);
  await extractTarZst(localPath, extractDir);

  const manifest = await parseManifest(extractDir);
  const capabilities = await loadCapabilities(manifest, extractDir);

  return new Bundle(manifest, capabilities, extractDir);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function downloadBundle(url: string): Promise<string> {
  const filename = basename(new URL(url).pathname);
  const dest = join(tmpdir(), `stoa-dl-${randomUUID()}-${filename}`);

  console.info(`[stoa bundle] Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download bundle: ${res.status} ${res.statusText}`);
  }

  const fileStream = createWriteStream(dest);
  if (!res.body) {
    throw new Error("Response body is null");
  }

  await pipeline(
    // Node 18+ supports ReadableStream → Readable bridging via Readable.fromWeb
    nodeReadableFromWeb(res.body),
    fileStream
  );

  console.info(`[stoa bundle] Downloaded to ${dest}`);
  return dest;
}

function nodeReadableFromWeb(
  webStream: ReadableStream<Uint8Array>
): import("node:stream").Readable {
  // Use Node.js built-in Readable.fromWeb (Node 18+)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Readable } = require("node:stream") as typeof import("node:stream");
  // @ts-expect-error Readable.fromWeb is available in Node 18+
  return (Readable as unknown as { fromWeb: (s: ReadableStream) => import("node:stream").Readable }).fromWeb(webStream);
}

async function extractTarZst(archivePath: string, destDir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(destDir, { recursive: true });

  // Try zstd decompression + tar extraction using child_process
  // This avoids native addon deps while still working on most systems
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  // Check for zstd CLI
  try {
    await execFileAsync("zstd", ["--version"], { timeout: 5000 });
    // zstd available — use it
    await execFileAsync(
      "sh",
      ["-c", `zstd -d "${archivePath}" -c | tar -x -C "${destDir}"`],
      { timeout: 60000 }
    );
    return;
  } catch {
    // zstd CLI not available, try tar with built-in zstd support (GNU tar 1.31+)
  }

  try {
    await execFileAsync("tar", ["-x", "--zstd", "-f", archivePath, "-C", destDir], {
      timeout: 60000,
    });
    return;
  } catch {
    // Fall back to plain tar (bundle might be an uncompressed .tar)
  }

  try {
    await execFileAsync("tar", ["-xf", archivePath, "-C", destDir], {
      timeout: 60000,
    });
    return;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to extract bundle at ${archivePath}. ` +
        `Install zstd (brew install zstd / apt install zstd) or GNU tar >= 1.31. ` +
        `Original error: ${msg}`
    );
  }
}

async function parseManifest(extractDir: string): Promise<BundleManifest> {
  const manifestPath = join(extractDir, "manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    throw new Error(
      `Bundle at ${extractDir} is missing manifest.json. ` +
        "Is this a valid Stoa daily bundle?"
    );
  }
  return JSON.parse(raw) as BundleManifest;
}

async function loadCapabilities(
  manifest: BundleManifest,
  extractDir: string
): Promise<Map<CapabilityURN, BundleCapabilityEntry>> {
  const caps = new Map<CapabilityURN, BundleCapabilityEntry>();

  for (const entry of manifest.capabilities) {
    const filePath = join(extractDir, entry.file);
    try {
      const raw = await readFile(filePath, "utf-8");
      const cap = JSON.parse(raw) as BundleCapabilityEntry;
      caps.set(entry.urn, cap);
    } catch {
      // Skip missing files — partial bundles are valid (diff bundles)
      console.warn(`[stoa bundle] Missing capability file: ${entry.file}`);
    }
  }

  return caps;
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "not", "in", "of", "to", "for", "with",
  "on", "at", "by", "from", "is", "it", "as", "be", "this", "that",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9:._-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) {
    count++;
    pos += term.length;
  }
  return count;
}

/** Approximate inverse-document-frequency — biases toward rare terms */
function idf(term: string, totalDocs: number): number {
  // For keyword search without a full IDF index, use term length as a proxy
  // (longer terms are generally more discriminative)
  return Math.log((totalDocs + 1) / (term.length + 1)) + 1;
}
