/**
 * @stoa/sdk — TypeScript reference client for the Stoa open agent-readable SaaS substrate.
 *
 * Stoa is the open standard, runtime, and federated registry that lets any agent
 * call any SaaS as a typed, signed, idempotent, cost-governed, audit-trailed
 * capability instead of clicking through a UI.
 *
 * Spec: https://github.com/stoa-spec/stoa-spec
 * Runtime: https://github.com/Vext-Labs-Inc/stoa-edge
 * License: Apache-2.0
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  CapabilityURN,
  ResourceURN,
  SideEffectKind,
  IdempotencyKind,
  RollbackKind,
  RemediationHint,
  Receipt,
  StateDelta,
  StateChangeOp,
  Cost,
  CostBreakdownItem,
  CapabilityError,
  SideEffects,
  Capability,
  CapabilityManifest,
  OnFailurePolicy,
  PlanStep,
  PlanDeclaration,
  StepResult,
  PlanResult,
  StoaError,
  RemediationInfo,
  LineageNode,
  LineageEdge,
  LineageGraph,
  BundleManifest,
  BundleCapabilityEntry,
  VerifyDetail,
  VerifyResult,
  StoaRuntime,
} from "./types.js";

// ---------------------------------------------------------------------------
// Wire schemas (Zod)
// ---------------------------------------------------------------------------

export {
  CapabilityURNSchema,
  ResourceURNSchema,
  RemediationHintSchema,
  ReceiptSchema,
  StateDeltaSchema,
  StateChangeOpSchema,
  CostSchema,
  StoaRequestSchema,
  StoaResponseSchema,
  StoaErrorEnvelopeSchema,
  AnyStoaResponseSchema,
  StoaDiscoverySchema,
  PlanStepSchema,
  PlanDeclarationSchema,
} from "./wire.js";

export type {
  StoaRequestInput,
  StoaRequestOutput,
  StoaResponseInput,
  StoaResponseOutput,
  StoaErrorEnvelopeInput,
  StoaErrorEnvelopeOutput,
  AnyStoaResponse,
  StoaDiscoveryInput,
  StoaDiscoveryOutput,
  PlanDeclarationInput,
  PlanDeclarationOutput,
} from "./wire.js";

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export { Plan } from "./plan.js";

// ---------------------------------------------------------------------------
// Execution engine
// ---------------------------------------------------------------------------

export { execute, StoaExecutionError } from "./execute.js";
export type { ExecuteOptions, ExecuteResult } from "./execute.js";

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export { verify, parseReceiptsJsonl, parseFoundationRoot } from "./verify.js";
export type { FoundationRoot } from "./verify.js";

// ---------------------------------------------------------------------------
// Offline bundles
// ---------------------------------------------------------------------------

export { loadBundle, Bundle } from "./offline.js";

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export { Sandbox } from "./sandbox.js";
export type { MockVendor, MockResponse, SandboxResult } from "./sandbox.js";

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export {
  lineageGraph,
  findAncestors,
  findDescendants,
  toDot,
} from "./lineage.js";
export type { ReceiptWithLineage } from "./lineage.js";

// ---------------------------------------------------------------------------
// Utilities (re-exported for convenience)
// ---------------------------------------------------------------------------

export { sha256, hashJson, idemKey, verifyMerkleProof } from "./util/hash.js";
export { resolveDidWeb, verifyReceiptSignature } from "./util/jws.js";

// ---------------------------------------------------------------------------
// SDK version
// ---------------------------------------------------------------------------

export const SDK_VERSION = "0.1.0";
export const STOA_SPEC_VERSION = "stoa-0.1";
