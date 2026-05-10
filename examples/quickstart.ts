/**
 * Stoa SDK quickstart — build a 3-step plan, execute it, verify receipts.
 *
 * Replace STOA_ENDPOINT and STOA_TOKEN with your actual values.
 * Run: npx tsx examples/quickstart.ts
 */

import {
  Plan,
  verify,
  parseFoundationRoot,
  loadBundle,
  type CapabilityURN,
  type StoaRuntime,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// 1. Configure the runtime
// ---------------------------------------------------------------------------

const runtime: StoaRuntime = {
  endpoint: process.env["STOA_ENDPOINT"] ?? "https://edge.stoa.foundation/v1/execute",
  authToken: process.env["STOA_TOKEN"],
};

// ---------------------------------------------------------------------------
// 2. Build a 3-step plan
//
//    Step 1: Query PostHog for pricing page visitors in the last 7 days
//    Step 2: Search HubSpot for matching contacts by email
//    Step 3: Fan-out — create a Cal.com event for each contact
// ---------------------------------------------------------------------------

const plan = new Plan("plan_quickstart_001")
  .asAgent("did:web:hive.vext.ai")
  .budget(250) // hard ceiling: 250 cents = $2.50
  .maxWallSeconds(300)
  .addStep(
    "urn:stoa:cap:posthog.events.query@2.0.0" as CapabilityURN,
    { event: "pricing_page_view", since: "-7d", distinct: true }
  )
  .addStep(
    "urn:stoa:cap:hubspot.contacts.search@2.3.1" as CapabilityURN,
    {},
    { input_from: { emails: "$.steps[1].output.distinct_emails" } }
  )
  .fanOut("$.steps[2].output.contacts")
  .addStep(
    "urn:stoa:cap:cal.events.create@1.5.2" as CapabilityURN,
    { duration_min: 30, title: "Stoa demo" },
    {
      input_from: { invitee_email: "$item.email" },
      require_human_confirmation: false,
    }
  )
  .onFailure("compensate");

// ---------------------------------------------------------------------------
// 3. Execute
// ---------------------------------------------------------------------------

console.log("Executing plan...");
const result = await plan.execute(runtime);

console.log(`\nPlan status: ${result.status}`);
console.log(`Total cost:  ${result.total_cost_cents}c`);
console.log(`Receipts:    ${result.receipts.length}`);

for (const step of result.steps) {
  const icon = step.status === "ok" ? "+" : step.status === "error" ? "x" : "-";
  console.log(`  [${icon}] step ${step.step_id}: ${step.cap}`);
  if (step.error) {
    console.log(`      error: ${step.error.code} — ${step.error.message}`);
    if (step.error.remediation) {
      console.log(`      hint:  ${step.error.remediation.hint}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Verify receipts
//
//    In a real flow the foundation root comes from:
//    https://caps.stoa.foundation/2026-05-10/full.tar.zst.sig
//
//    Here we use a placeholder since we may not have a real root.
// ---------------------------------------------------------------------------

if (result.receipts.length > 0) {
  console.log("\nVerifying receipts...");

  const foundationRoot = parseFoundationRoot(
    process.env["STOA_FOUNDATION_ROOT"] ??
      JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        root: "0xplaceholder_replace_with_real_daily_root",
        sig: "",
      })
  );

  const verifyResult = await verify(result.receipts, foundationRoot, {
    skipSignatureVerification: !process.env["STOA_VERIFY_SIG"],
    skipMerkleVerification: !process.env["STOA_VERIFY_MERKLE"],
    verbose: true,
  });

  console.log(`  Valid:   ${verifyResult.valid}`);
  console.log(`  Invalid: ${verifyResult.invalid}`);
}

// ---------------------------------------------------------------------------
// 5. (Optional) Search the local capability bundle
//
//    Pull a bundle first: stoa pull https://caps.stoa.foundation/2026-05-10/full.tar.zst
// ---------------------------------------------------------------------------

const bundlePath = process.env["STOA_BUNDLE_PATH"];
if (bundlePath) {
  console.log("\nSearching bundle for 'send email'...");
  const bundle = await loadBundle(bundlePath);
  const results = bundle.search("send email", { topK: 3 });
  for (const r of results) {
    console.log(`  ${r.urn} (score: ${r.score.toFixed(3)})`);
    if (r.entry.summary) console.log(`    ${r.entry.summary}`);
  }
}

console.log("\nDone.");
