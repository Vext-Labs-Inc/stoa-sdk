/**
 * Zod schemas for Stoa/1 wire envelopes.
 *
 * Matches the shapes defined in STOA.md §5 and SPEC_V0_1.md §4-§5.
 * Kept deliberately permissive (z.unknown() for data payloads) so the SDK
 * remains forward-compatible as the spec evolves.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const CapabilityURNSchema = z
  .string()
  .startsWith("urn:stoa:cap:", { message: "Must be a Stoa capability URN" });

export const ResourceURNSchema = z
  .string()
  .startsWith("urn:stoa:", { message: "Must be a Stoa URN" });

export const RemediationHintSchema = z.enum([
  "fix-input-and-retry",
  "backoff",
  "auth-refresh",
  "escalate-to-user",
  "permanent-failure",
  "search-then-update",
  "search-then-merge",
  "wait-and-poll",
  "compose-different-capabilities",
  "request-budget-increase",
  "route-to-compliant-vendor",
]);

// ---------------------------------------------------------------------------
// Receipt schema (§11)
// ---------------------------------------------------------------------------

export const ReceiptSchema = z.object({
  alg: z.string(),
  sig: z.string(),
  vendor_did: z.string(),
  agent_co_sig: z.string().optional(),
  ts: z.number().int(),
  cap: CapabilityURNSchema,
  input_hash: z.string(),
  output_hash: z.string(),
  state_delta_hash: z.string().optional(),
  cost_actual_cents: z.number().optional(),
  settlement_ref: z.string().optional(),
  trace_id: z.string().optional(),
  merkle_root: z.string(),
  merkle_proof: z.array(z.string()),
});

export type ReceiptInput = z.input<typeof ReceiptSchema>;
export type ReceiptOutput = z.output<typeof ReceiptSchema>;

// ---------------------------------------------------------------------------
// State delta schema (§5.2 / §4)
// ---------------------------------------------------------------------------

export const StateChangeOpSchema = z.object({
  op: z.enum(["create", "replace", "remove", "add"]),
  path: z.string(),
  value_hash: z.string().optional(),
  old_hash: z.string().optional(),
  new_hash: z.string().optional(),
});

export const StateDeltaSchema = z.object({
  resource: ResourceURNSchema,
  version: z.number().int(),
  etag: z.string().optional(),
  changeset: z.array(StateChangeOpSchema),
});

// ---------------------------------------------------------------------------
// Cost schema
// ---------------------------------------------------------------------------

export const CostSchema = z.object({
  actual_cents: z.number(),
  breakdown: z.array(
    z.object({
      kind: z.string(),
      amount_cents: z.number(),
    })
  ),
  settlement_ref: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Side effects in response
// ---------------------------------------------------------------------------

export const ResponseSideEffectSchema = z.object({
  kind: z.string(),
  when: z.string().optional(),
  undo: z.string().optional(),
  undo_args: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Warning schema
// ---------------------------------------------------------------------------

export const WarningSchema = z.object({
  code: z.string(),
  field: z.string().optional(),
  removal: z.string().optional(),
  message: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Lineage schema (§16)
// ---------------------------------------------------------------------------

export const LineageSchema = z.object({
  consumed_resources: z.array(z.string()).optional(),
  produced_resource: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Stoa/1 Request envelope (§5.1)
// ---------------------------------------------------------------------------

export const StoaRequestSchema = z.object({
  stoa: z.literal("1"),
  cap: CapabilityURNSchema,
  idem: z.string().optional(),
  agent: z
    .object({
      jwt: z.string().optional(),
      issuer: z.string().optional(),
      reputation_hint: z.string().optional(),
    })
    .optional(),
  trace: z
    .object({
      parent: z.string().optional(),
      plan: z.string().optional(),
      step: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
  budget: z
    .object({
      ceiling_cents: z.number().optional(),
      currency: z.string().optional(),
      settlement: z.string().optional(),
    })
    .optional(),
  privacy: z
    .object({
      input_classes: z.array(z.string()).optional(),
      output_classes: z.array(z.string()).optional(),
      jurisdiction: z.string().optional(),
    })
    .optional(),
  resume: z.string().nullable().optional(),
  input: z.record(z.unknown()),
  compensation: z
    .object({
      on_undo: z.string().optional(),
      key_path: z.string().optional(),
    })
    .optional(),
  policy: z
    .object({
      require_human_confirmation: z.boolean().optional(),
      max_retry: z.number().int().optional(),
      preferred_region: z.string().optional(),
    })
    .optional(),
});

export type StoaRequestInput = z.input<typeof StoaRequestSchema>;
export type StoaRequestOutput = z.output<typeof StoaRequestSchema>;

// ---------------------------------------------------------------------------
// Stoa/1 Success response envelope (§5.2)
// ---------------------------------------------------------------------------

export const StoaResponseSchema = z.object({
  stoa: z.literal("1"),
  status: z.literal("ok"),
  receipt: ReceiptSchema.optional(),
  state_delta: StateDeltaSchema.optional(),
  continuation: z.string().nullable().optional(),
  cost: CostSchema.optional(),
  side_effects: z.array(ResponseSideEffectSchema).optional(),
  warnings: z.array(WarningSchema).optional(),
  lineage: LineageSchema.optional(),
  output: z.unknown(),
});

export type StoaResponseInput = z.input<typeof StoaResponseSchema>;
export type StoaResponseOutput = z.output<typeof StoaResponseSchema>;

// ---------------------------------------------------------------------------
// Stoa/1 Error envelope (§5.3)
// ---------------------------------------------------------------------------

export const StoaErrorEnvelopeSchema = z.object({
  stoa: z.literal("1"),
  status: z.literal("error"),
  error: z.object({
    code: z.string(),
    message: z.string(),
    remediation: z
      .object({
        hint: RemediationHintSchema,
        next_capability: CapabilityURNSchema.optional(),
        retry_after_ms: z.number().nullable().optional(),
        compose_hint: z.string().nullable().optional(),
      })
      .optional(),
    trace_id: z.string().optional(),
    details: z.record(z.unknown()).optional(),
  }),
  receipt: ReceiptSchema.optional(),
  envelope: z
    .object({
      id: z.string().nullable().optional(),
      as_of: z.string().optional(),
    })
    .optional(),
});

export type StoaErrorEnvelopeInput = z.input<typeof StoaErrorEnvelopeSchema>;
export type StoaErrorEnvelopeOutput = z.output<typeof StoaErrorEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Union: any Stoa/1 response
// ---------------------------------------------------------------------------

export const AnyStoaResponseSchema = z.discriminatedUnion("status", [
  StoaResponseSchema,
  StoaErrorEnvelopeSchema,
]);

export type AnyStoaResponse = z.output<typeof AnyStoaResponseSchema>;

// ---------------------------------------------------------------------------
// Discovery document schema (§2 / §2 SPEC)
// ---------------------------------------------------------------------------

export const StoaDiscoverySchema = z.object({
  spec_version: z.string(),
  vendor: z.object({
    name: z.string(),
    homepage: z.string().optional(),
    support_email: z.string().optional(),
    verified: z.boolean().optional(),
  }),
  manifest_url: z.string(),
  openapi_url: z.string().optional(),
  mcp_url: z.string().optional(),
  auth: z
    .object({
      kinds: z.array(z.string()).optional(),
      oauth2_well_known: z.string().optional(),
    })
    .optional(),
  rate_limits: z
    .object({
      default_qps: z.number().optional(),
      burst: z.number().optional(),
      documented_at: z.string().optional(),
    })
    .optional(),
  conformance: z
    .object({
      level: z.string().optional(),
      tested_at: z.string().optional(),
      report_url: z.string().optional(),
    })
    .optional(),
});

export type StoaDiscoveryInput = z.input<typeof StoaDiscoverySchema>;
export type StoaDiscoveryOutput = z.output<typeof StoaDiscoverySchema>;

// ---------------------------------------------------------------------------
// Plan declaration schema (§15)
// ---------------------------------------------------------------------------

export const PlanStepSchema = z.object({
  id: z.union([z.number(), z.string()]),
  cap: CapabilityURNSchema,
  input: z.record(z.unknown()).optional(),
  input_from: z.record(z.string()).optional(),
  fan_out: z.string().optional(),
  depends_on: z.array(z.union([z.number(), z.string()])).optional(),
  idem: z.string().optional(),
  policy: z
    .object({
      max_retry: z.number().int().optional(),
      require_human_confirmation: z.boolean().optional(),
      preferred_region: z.string().optional(),
    })
    .optional(),
});

export const PlanDeclarationSchema = z.object({
  plan_id: z.string(),
  agent: z.string().optional(),
  budget_ceiling_cents: z.number().optional(),
  max_wall_seconds: z.number().optional(),
  steps: z.array(PlanStepSchema),
  on_failure: z
    .enum(["compensate", "abort", "report_and_continue", "ignore"])
    .optional()
    .default("compensate"),
  on_partial_success: z
    .enum(["compensate", "abort", "report_and_continue", "ignore"])
    .optional()
    .default("report_and_continue"),
});

export type PlanDeclarationInput = z.input<typeof PlanDeclarationSchema>;
export type PlanDeclarationOutput = z.output<typeof PlanDeclarationSchema>;
