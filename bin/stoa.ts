#!/usr/bin/env node
/**
 * stoa CLI — reference client for the Stoa open agent substrate.
 *
 * Commands:
 *   stoa verify <receipts.jsonl> --root <root.sig>   Verify receipts
 *   stoa pull <bundle-url>                           Download + verify a daily bundle
 *   stoa search <query>                              Search local bundle
 *   stoa execute <plan.yaml>                         Execute a plan declaration
 */

import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// SDK imports (from src directly — tsup bundles these together)
// ---------------------------------------------------------------------------

import {
  verify,
  parseReceiptsJsonl,
  parseFoundationRoot,
} from "../src/verify.js";
import { loadBundle } from "../src/offline.js";
import { Plan } from "../src/plan.js";
import type { CapabilityURN, StoaRuntime } from "../src/types.js";
import type { PlanDeclarationInput } from "../src/wire.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Read package.json for version
// ---------------------------------------------------------------------------

let pkgVersion = "0.1.0";
try {
  const pkgPath = join(__dirname, "../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // ignore
}

// ---------------------------------------------------------------------------
// CLI setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("stoa")
  .description(
    "CLI for the Stoa open agent-readable SaaS substrate.\n" +
      "Spec: https://github.com/stoa-spec/stoa-spec"
  )
  .version(pkgVersion);

// ---------------------------------------------------------------------------
// stoa verify <receipts.jsonl> --root <root.sig>
// ---------------------------------------------------------------------------

program
  .command("verify <receipts-file>")
  .description(
    "Verify Stoa receipts against a foundation daily root.\n\n" +
      "receipts-file: path to a .jsonl file (one receipt JSON per line)\n\n" +
      "Example:\n" +
      "  stoa verify receipts.jsonl --root foundation.sig\n" +
      "  stoa verify receipts.jsonl --root 0x9f... --skip-sig"
  )
  .requiredOption("--root <root>", "Foundation daily root (.sig file path or raw hex string)")
  .option("--skip-sig", "Skip JWS signature verification (offline/test mode)", false)
  .option("--skip-merkle", "Skip Merkle proof verification", false)
  .option("--verbose", "Print per-receipt detail", false)
  .option("--output-json", "Output results as JSON instead of human-readable", false)
  .action(async (receiptsFile: string, opts: {
    root: string;
    skipSig: boolean;
    skipMerkle: boolean;
    verbose: boolean;
    outputJson: boolean;
  }) => {
    try {
      // Load receipts
      let receiptsContent: string;
      try {
        receiptsContent = await readFile(receiptsFile, "utf-8");
      } catch {
        console.error(`[stoa verify] Error: Cannot read receipts file: ${receiptsFile}`);
        console.error("  Make sure the file exists and is readable.");
        console.error("  Expected format: one JSON receipt object per line (JSONL).");
        process.exit(1);
      }

      const receipts = parseReceiptsJsonl(receiptsContent);

      if (receipts.length === 0) {
        console.warn("[stoa verify] Warning: No receipts found in file.");
        console.warn(
          "  Expected format: one JSON receipt object per line.\n" +
            "  Each line must be a valid Stoa receipt with: sig, vendor_did, cap, ts, " +
            "input_hash, output_hash, merkle_root, merkle_proof."
        );
        process.exit(0);
      }

      // Load root
      let rootContent: string;
      try {
        rootContent = await readFile(opts.root, "utf-8");
      } catch {
        // Try as raw hex/JSON string
        rootContent = opts.root;
      }

      const foundationRoot = parseFoundationRoot(rootContent);

      console.error(
        `[stoa verify] Verifying ${receipts.length} receipt(s) against root ${foundationRoot.root.slice(0, 16)}...`
      );

      const result = await verify(receipts, foundationRoot, {
        skipSignatureVerification: opts.skipSig,
        skipMerkleVerification: opts.skipMerkle,
        verbose: opts.verbose,
      });

      if (opts.outputJson) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.invalid > 0 ? 1 : 0);
      }

      // Human-readable output
      const passed = result.valid;
      const failed = result.invalid;

      console.log(`\n${checkmark(passed > 0)} ${passed} receipt${passed === 1 ? "" : "s"} verified`);
      console.log(`${cross(failed > 0)} ${failed} invalid signature${failed === 1 ? "" : "s"}`);

      let missingProofs = 0;
      let rootMismatches = 0;

      for (const d of result.details) {
        if (!d.valid && d.reason?.includes("merkle")) missingProofs++;
        if (!d.valid && d.reason?.includes("Root mismatch")) rootMismatches++;
      }

      console.log(`${cross(missingProofs > 0)} ${missingProofs} missing merkle proofs`);
      console.log(`${cross(rootMismatches > 0)} ${rootMismatches} root mismatches`);

      if (opts.verbose || failed > 0) {
        console.log("\nDetails:");
        for (const d of result.details) {
          if (!d.valid || opts.verbose) {
            const status = d.valid ? "PASS" : "FAIL";
            const cap = d.receipt.cap ?? "unknown cap";
            const vendor = d.receipt.vendor_did ?? "unknown vendor";
            console.log(
              `  [${status}] receipt ${d.index + 1}: ${cap} (${vendor})` +
                (d.reason ? `\n         reason: ${d.reason}` : "")
            );
          }
        }
      }

      process.exit(failed > 0 ? 1 : 0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[stoa verify] Fatal error: ${msg}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// stoa pull <bundle-url>
// ---------------------------------------------------------------------------

program
  .command("pull <bundle-url>")
  .description(
    "Download and verify a Stoa daily capability bundle.\n\n" +
      "Example:\n" +
      "  stoa pull https://caps.stoa.foundation/2026-05-10/full.tar.zst\n" +
      "  stoa pull ./local-bundle.tar.zst"
  )
  .option("--output-dir <dir>", "Directory to save the bundle", ".")
  .option("--list", "List capabilities in the bundle after pulling", false)
  .action(async (bundleUrl: string, opts: { outputDir: string; list: boolean }) => {
    try {
      console.error(`[stoa pull] Loading bundle: ${bundleUrl}`);
      const bundle = await loadBundle(bundleUrl);

      const capCount = bundle.list().length;
      const date = bundle.manifest.date ?? "unknown date";
      const registry = bundle.manifest.registry ?? "unknown registry";

      console.log(`Bundle loaded: ${date} from ${registry}`);
      console.log(`Capabilities: ${capCount}`);
      console.log(`Extract dir: ${bundle.extractDir}`);

      if (bundle.manifest.roots && bundle.manifest.roots.length > 0) {
        console.log(`Roots: ${bundle.manifest.roots.map((r) => r.issuer).join(", ")}`);
      }

      if (opts.list) {
        console.log("\nCapabilities:");
        for (const urn of bundle.list().slice(0, 50)) {
          console.log(`  ${urn}`);
        }
        if (capCount > 50) {
          console.log(`  ... and ${capCount - 50} more`);
        }
      }

      console.log("\nDone. Use `stoa search <query>` to query the bundle.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[stoa pull] Error: ${msg}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// stoa search <query>
// ---------------------------------------------------------------------------

program
  .command("search <query>")
  .description(
    "Search the local bundle for capabilities matching a query.\n\n" +
      "Example:\n" +
      "  stoa search 'create a contact'\n" +
      "  stoa search 'send email' --top 5\n" +
      "  stoa search 'hubspot contacts' --bundle ./my-bundle.tar.zst"
  )
  .option("--bundle <path>", "Path to local bundle (default: find in /tmp)", "")
  .option("--top <n>", "Max results to show", "10")
  .option("--min-score <n>", "Minimum similarity score 0-1", "0")
  .action(async (query: string, opts: { bundle: string; top: string; minScore: string }) => {
    try {
      let bundlePath = opts.bundle;

      if (!bundlePath) {
        // Try to find a recent bundle in /tmp
        const { execSync } = await import("node:child_process");
        try {
          const found = execSync("ls -t /tmp/stoa-bundle-*/manifest.json 2>/dev/null | head -1", {
            encoding: "utf-8",
          }).trim();
          if (found) {
            bundlePath = found.replace("/manifest.json", "");
            console.error(`[stoa search] Using bundle at ${bundlePath}`);
          }
        } catch {
          // ignore
        }
      }

      if (!bundlePath) {
        console.error(
          "[stoa search] No bundle found. Run `stoa pull <bundle-url>` first, " +
            "or specify --bundle <path>."
        );
        process.exit(1);
      }

      const bundle = await loadBundle(bundlePath);
      const results = bundle.search(query, {
        topK: parseInt(opts.top, 10),
        minScore: parseFloat(opts.minScore),
      });

      if (results.length === 0) {
        console.log(`No capabilities found matching "${query}"`);
        process.exit(0);
      }

      console.log(`Results for "${query}":\n`);
      for (const r of results) {
        const price = r.entry.price?.current_cents
          ? `$${(r.entry.price.current_cents / 100).toFixed(4)}`
          : "free/unknown";
        const reliability = r.entry.reliability?.window_24h
          ? `${(r.entry.reliability.window_24h * 100).toFixed(1)}% uptime`
          : "";
        const scopes = (r.entry.scopes_required ?? []).join(", ");

        console.log(`  ${r.urn}`);
        if (r.entry.summary) console.log(`    ${r.entry.summary}`);
        console.log(
          `    vendor: ${r.entry.vendor_did}  price: ${price}  ${reliability}` +
            (scopes ? `  scopes: ${scopes}` : "")
        );
        console.log(`    score: ${r.score.toFixed(3)}`);
        console.log();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[stoa search] Error: ${msg}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// stoa execute <plan.yaml>
// ---------------------------------------------------------------------------

program
  .command("execute <plan-file>")
  .description(
    "Execute a plan declaration (YAML or JSON) against a Stoa endpoint.\n\n" +
      "Example:\n" +
      "  stoa execute plan.yaml --endpoint https://edge.stoa.foundation/v1/execute\n" +
      "  stoa execute plan.json --endpoint $STOA_ENDPOINT --token $STOA_TOKEN"
  )
  .requiredOption(
    "--endpoint <url>",
    "Stoa endpoint URL (or set STOA_ENDPOINT env var)",
    process.env["STOA_ENDPOINT"] ?? ""
  )
  .option(
    "--token <token>",
    "Auth token (or set STOA_TOKEN env var)",
    process.env["STOA_TOKEN"]
  )
  .option("--dry-run", "Parse and validate the plan without executing", false)
  .option("--output-json", "Output results as JSON", false)
  .action(
    async (
      planFile: string,
      opts: {
        endpoint: string;
        token?: string;
        dryRun: boolean;
        outputJson: boolean;
      }
    ) => {
      try {
        if (!opts.endpoint) {
          console.error(
            "[stoa execute] Error: --endpoint is required, or set STOA_ENDPOINT env var."
          );
          process.exit(1);
        }

        // Load plan file
        let planContent: string;
        try {
          planContent = await readFile(planFile, "utf-8");
        } catch {
          console.error(`[stoa execute] Error: Cannot read plan file: ${planFile}`);
          process.exit(1);
        }

        // Parse plan (JSON or YAML)
        let planDecl: PlanDeclarationInput;
        try {
          planDecl = JSON.parse(planContent) as PlanDeclarationInput;
        } catch {
          // Try YAML — requires yaml package which we don't bundle
          // Provide helpful error
          console.error(
            "[stoa execute] Error: Plan file must be valid JSON.\n" +
              "  YAML support: convert to JSON with `yq eval -o=json plan.yaml`"
          );
          process.exit(1);
        }

        // Build Plan from declaration
        const plan = new Plan(planDecl.plan_id);
        if (planDecl.budget_ceiling_cents) plan.budget(planDecl.budget_ceiling_cents);
        if (planDecl.max_wall_seconds) plan.maxWallSeconds(planDecl.max_wall_seconds);
        if (planDecl.on_failure) plan.onFailure(planDecl.on_failure);

        for (const step of planDecl.steps) {
          plan.addStep(
            step.cap as CapabilityURN,
            step.input,
            {
              input_from: step.input_from,
              depends_on: step.depends_on as number[] | undefined,
              max_retry: step.policy?.max_retry,
              require_human_confirmation: step.policy?.require_human_confirmation,
              preferred_region: step.policy?.preferred_region,
            }
          );
          if (step.fan_out) plan.fanOut(step.fan_out);
        }

        const decl = plan.toDeclaration();
        console.error(
          `[stoa execute] Plan ${decl.plan_id} — ${decl.steps.length} step(s)`
        );

        if (opts.dryRun) {
          console.log("Dry run — plan validated:");
          console.log(JSON.stringify(decl, null, 2));
          process.exit(0);
        }

        const runtime: StoaRuntime = {
          endpoint: opts.endpoint,
          authToken: opts.token,
        };

        const result = await plan.execute(runtime);

        if (opts.outputJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\nPlan ${result.plan_id} — status: ${result.status.toUpperCase()}`);
          console.log(`Total cost: ${result.total_cost_cents}c`);
          console.log(`Steps:`);
          for (const step of result.steps) {
            const icon = step.status === "ok" ? "+" : step.status === "error" ? "x" : "-";
            console.log(`  [${icon}] step ${step.step_id}: ${step.cap} (${step.status})`);
            if (step.error) {
              console.log(`      error: ${step.error.code} — ${step.error.message}`);
              if (step.error.remediation) {
                console.log(`      hint:  ${step.error.remediation.hint}`);
              }
            }
          }
          if (result.receipts.length > 0) {
            console.log(`\nReceipts: ${result.receipts.length}`);
          }
        }

        process.exit(result.status === "ok" || result.status === "partial" ? 0 : 1);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[stoa execute] Fatal error: ${msg}`);
        process.exit(1);
      }
    }
  );

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

program.parse(process.argv);

if (process.argv.length <= 2) {
  program.help();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkmark(active: boolean): string {
  return active ? "+" : " ";
}

function cross(active: boolean): string {
  return active ? "x" : " ";
}
