/**
 * Core TypeScript types for Stoa v0.1
 *
 * Shapes align with STOA.md §5 (wire), §11 (receipts), §14 (offline bundles),
 * §15 (composition primitives), §16 (sandbox/replay/lineage).
 */

// ---------------------------------------------------------------------------
// Capability URN
// ---------------------------------------------------------------------------

/** A stable capability URN: urn:stoa:cap:<domain>.<resource>.<action>@<version> */
export type CapabilityURN = `urn:stoa:cap:${string}`;

/** A stable resource URN: urn:stoa:res:<domain>.<type>:<id> */
export type ResourceURN = `urn:stoa:res:${string}`;

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

export type SideEffectKind = "read" | "create" | "update" | "delete" | "action" | "query";

export type IdempotencyKind = "none" | "client-key" | "natural-key" | "server-dedupe";

export type RollbackKind =
  | "none"
  | "delete-by-id"
  | "update-with-prior-state"
  | `compensating-action:${string}`;

// ---------------------------------------------------------------------------
// Remediation hints
// ---------------------------------------------------------------------------

export type RemediationHint =
  | "fix-input-and-retry"
  | "backoff"
  | "auth-refresh"
  | "escalate-to-user"
  | "permanent-failure"
  | "search-then-update"
  | "search-then-merge"
  | "wait-and-poll"
  | "compose-different-capabilities"
  | "request-budget-increase"
  | "route-to-compliant-vendor";

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

export interface Receipt {
  alg: string;
  sig: string;
  vendor_did: string;
  agent_co_sig?: string;
  ts: number;
  cap: CapabilityURN;
  input_hash: string;
  output_hash: string;
  state_delta_hash?: string;
  cost_actual_cents?: number;
  settlement_ref?: string;
  trace_id?: string;
  merkle_root: string;
  merkle_proof: string[];
}

// ---------------------------------------------------------------------------
// State delta
// ---------------------------------------------------------------------------

export interface StateChangeOp {
  op: "create" | "replace" | "remove" | "add";
  path: string;
  value_hash?: string;
  old_hash?: string;
  new_hash?: string;
}

export interface StateDelta {
  resource: ResourceURN;
  version: number;
  etag?: string;
  changeset: StateChangeOp[];
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface CostBreakdownItem {
  kind: string;
  amount_cents: number;
}

export interface Cost {
  actual_cents: number;
  breakdown: CostBreakdownItem[];
  settlement_ref?: string;
}

// ---------------------------------------------------------------------------
// Capability manifest types
// ---------------------------------------------------------------------------

export interface CapabilityError {
  code: string;
  remediation: RemediationHint;
}

export interface SideEffects {
  kind: SideEffectKind;
  idempotency: IdempotencyKind;
  rollback?: RollbackKind;
  destructive?: boolean;
  requires_confirmation?: boolean;
  rate_class?: string;
}

export interface Capability {
  id: string;
  summary: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  side_effects?: SideEffects;
  scopes?: string[];
  errors?: CapabilityError[];
  openapi_path?: string;
  openapi_method?: string;
  compensation?: {
    cap: CapabilityURN;
    key_path: string;
    constraints?: Array<{ kind: string; [key: string]: unknown }>;
  };
}

export interface CapabilityManifest {
  spec_version: string;
  manifest_id?: string;
  manifest_version?: string;
  vendor: string;
  capabilities: Capability[];
  components?: {
    schemas?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export type OnFailurePolicy = "compensate" | "abort" | "report_and_continue" | "ignore";

export interface PlanStep {
  id: number | string;
  cap: CapabilityURN;
  input?: Record<string, unknown>;
  input_from?: Record<string, string>;
  fan_out?: string;
  depends_on?: Array<number | string>;
  idem?: string;
  policy?: {
    max_retry?: number;
    require_human_confirmation?: boolean;
    preferred_region?: string;
  };
}

export interface PlanDeclaration {
  plan_id: string;
  agent?: string;
  budget_ceiling_cents?: number;
  max_wall_seconds?: number;
  steps: PlanStep[];
  on_failure?: OnFailurePolicy;
  on_partial_success?: OnFailurePolicy;
}

export interface StepResult {
  step_id: number | string;
  cap: CapabilityURN;
  status: "ok" | "error" | "skipped" | "compensated";
  output?: unknown;
  receipt?: Receipt;
  state_delta?: StateDelta;
  cost?: Cost;
  error?: StoaError;
}

export interface PlanResult {
  plan_id: string;
  status: "ok" | "partial" | "failed" | "compensated";
  steps: StepResult[];
  receipts: Receipt[];
  total_cost_cents: number;
  lineage: LineageGraph;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export interface RemediationInfo {
  hint: RemediationHint;
  next_capability?: CapabilityURN;
  retry_after_ms?: number | null;
  compose_hint?: string | null;
}

export interface StoaError {
  code: string;
  message: string;
  remediation?: RemediationInfo;
  trace_id?: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Lineage graph
// ---------------------------------------------------------------------------

export interface LineageNode {
  resource: ResourceURN | string;
  produced_by?: CapabilityURN;
  consumed_by?: CapabilityURN[];
  ts?: number;
}

export interface LineageEdge {
  from: string;
  to: string;
  via: CapabilityURN;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

// ---------------------------------------------------------------------------
// Offline bundle
// ---------------------------------------------------------------------------

export interface BundleManifest {
  date: string;
  registry: string;
  capabilities: Array<{
    urn: CapabilityURN;
    file: string;
    content_hash: string;
    embedding_offset?: number;
    embedding_dim?: number;
  }>;
  roots: Array<{
    issuer: string;
    sig: string;
    algorithm: string;
  }>;
}

export interface BundleCapabilityEntry {
  urn: CapabilityURN;
  vendor_did: string;
  summary?: string;
  schema?: {
    input_ref?: string;
    output_ref?: string;
    schema_hash?: string;
  };
  embedding?: number[];
  price?: {
    current_cents?: number;
    stale_after?: number;
  };
  reliability?: {
    window_24h?: number;
    p50_latency_ms?: number;
    p99_latency_ms?: number;
    samples?: number;
  };
  privacy_zones?: string[];
  compensation?: string;
  side_effect_class?: string;
  scopes_required?: string[];
}

// ---------------------------------------------------------------------------
// Verify result
// ---------------------------------------------------------------------------

export interface VerifyDetail {
  index: number;
  receipt: Receipt;
  valid: boolean;
  reason?: string;
}

export interface VerifyResult {
  valid: number;
  invalid: number;
  details: VerifyDetail[];
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface StoaRuntime {
  endpoint: string;
  authToken?: string;
  agentJwt?: string;
  agentDid?: string;
}
