# @stoa/sdk

TypeScript reference client for [Stoa](https://github.com/stoa-spec/stoa-spec) — the open standard, runtime, and federated registry that lets any agent call any SaaS as a typed, signed, idempotent, cost-governed, audit-trailed capability.

Spec: CC-BY-4.0. SDK: Apache-2.0.

---

## Install

```bash
npm install @stoa/sdk
```

Node 18+ required.

---

## Quickstart

```typescript
import { Plan, verify, parseFoundationRoot } from "@stoa/sdk";

// 1. Build a plan
const plan = new Plan("plan_001")
  .asAgent("did:web:hive.vext.ai")
  .budget(250) // ceiling: 250 cents
  .addStep("urn:stoa:cap:posthog.events.query@2.0.0", {
    event: "pricing_page_view",
    since: "-7d",
  })
  .addStep("urn:stoa:cap:hubspot.contacts.search@2.3.1", {}, {
    input_from: { emails: "$.steps[1].output.distinct_emails" },
  })
  .fanOut("$.steps[2].output.contacts")
  .addStep("urn:stoa:cap:cal.events.create@1.5.2", { duration_min: 30 })
  .onFailure("compensate");

// 2. Execute
const result = await plan.execute({
  endpoint: process.env.STOA_ENDPOINT,
  authToken: process.env.STOA_TOKEN,
});

console.log(result.status, result.total_cost_cents + "c");

// 3. Verify receipts
const root = parseFoundationRoot(await readFile("foundation.sig", "utf-8"));
const v = await verify(result.receipts, root);
console.log(`${v.valid} valid, ${v.invalid} invalid`);
```

---

## CLI

```bash
npx @stoa/sdk verify receipts.jsonl --root foundation.sig
npx @stoa/sdk pull https://caps.stoa.foundation/2026-05-10/full.tar.zst
npx @stoa/sdk search "create a contact" --bundle ./bundle.tar.zst
npx @stoa/sdk execute plan.json --endpoint $STOA_ENDPOINT
```

### `stoa verify`

Verifies Stoa receipt signatures against a foundation daily root. The killer demo:

```bash
stoa verify receipts.jsonl --root foundation.sig
# + 412 receipts verified
#   0 invalid signatures
#   0 missing merkle proofs
#   0 root mismatches
```

Returns exit code 1 if any receipts are invalid. Pipe to CI or a SIEM connector.

### `stoa pull`

Downloads and parses a daily capability bundle from any registry:

```bash
stoa pull https://caps.stoa.foundation/2026-05-10/full.tar.zst --list
```

### `stoa search`

Semantic keyword search over a local bundle (no network needed):

```bash
stoa search "send transactional email" --top 5
```

### `stoa execute`

Execute a plan declaration from a JSON file:

```bash
stoa execute plan.json --endpoint https://edge.stoa.foundation/v1/execute --token $TOKEN
```

---

## Core API

### `Plan`

Builder for multi-step Stoa plans with saga compensation.

```typescript
import { Plan } from "@stoa/sdk";

const plan = new Plan("plan_id")
  .addStep(cap, input, options)
  .fanOut(jsonPath)         // fan next step over array items
  .onFailure("compensate") // compensate | abort | report_and_continue | ignore
  .budget(ceilingCents)
  .execute(runtime);        // returns PlanResult
```

### `verify`

Receipt verification against a foundation daily root.

```typescript
import { verify, parseReceiptsJsonl, parseFoundationRoot } from "@stoa/sdk";

const receipts = parseReceiptsJsonl(await readFile("receipts.jsonl", "utf-8"));
const root = parseFoundationRoot(await readFile("foundation.sig", "utf-8"));
const result = await verify(receipts, root, { skipSignatureVerification: false });
// { valid: number, invalid: number, details: [...] }
```

### `loadBundle`

Load an offline capability bundle (local path or remote URL).

```typescript
import { loadBundle } from "@stoa/sdk";

const bundle = await loadBundle("https://caps.stoa.foundation/2026-05-10/full.tar.zst");
// or: loadBundle("./local-bundle.tar.zst")

const cap = bundle.get("urn:stoa:cap:hubspot.contacts.create@2.3.1");
const results = bundle.search("send email", { topK: 5 });
```

### `Sandbox`

Execute a plan against canned mock responses — no network, no side effects.

```typescript
import { Sandbox, Plan } from "@stoa/sdk";

const vendor = new Map([
  ["urn:stoa:cap:hubspot.contacts.create@2.3.1", {
    status: "ok",
    output: { id: "84021", email: "test@example.com" },
  }],
]);

const result = await Sandbox.run(plan, "2026-05-10", vendor);
```

### `lineageGraph`

Build a data lineage graph from receipts.

```typescript
import { lineageGraph, toDot } from "@stoa/sdk";

const graph = lineageGraph(receipts);
console.log(toDot(graph)); // Graphviz DOT format
```

---

## Wire schemas

All Stoa/1 envelope shapes are exported as Zod schemas:

```typescript
import { StoaRequestSchema, StoaResponseSchema, ReceiptSchema } from "@stoa/sdk";

const req = StoaRequestSchema.parse(rawRequest);  // throws on invalid
```

---

## What is Stoa?

Stoa is the open standard for agent-readable SaaS. Instead of clicking through UIs, agents call typed, signed, idempotent capabilities with automatic saga compensation. Three artifacts:

- **The standard** — Stoa/1 wire protocol (capability manifest, state envelope, signed receipts, typed errors)
- **The runtime** — Stoa Edge (stateless workers, Saga DO, Budget DO, receipt anchoring)
- **The network** — federated capability graph (signed Merkle tree, embeddings, daily bundles)

Spec: [github.com/stoa-spec/stoa-spec](https://github.com/stoa-spec/stoa-spec)
Runtime: [github.com/Vext-Labs-Inc/stoa-edge](https://github.com/Vext-Labs-Inc/stoa-edge)
Registry: [caps.stoa.foundation](https://caps.stoa.foundation/)

---

## License

Apache-2.0. See [LICENSE](LICENSE).

Spec text is CC-BY-4.0 (Stoa Spec contributors).
