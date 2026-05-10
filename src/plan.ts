/**
 * Plan builder — fluent API for constructing and executing multi-step Stoa plans.
 *
 * Usage:
 *   const result = await new Plan("plan_482")
 *     .addStep("urn:stoa:cap:posthog.events.query@2.0.0", { event: "signup" })
 *     .addStep("urn:stoa:cap:hubspot.contacts.create@2.3.1", { email: "..." })
 *     .fanOut("$.steps[0].output.emails")
 *     .onFailure("compensate")
 *     .execute(runtime);
 *
 * Reference: STOA.md §15 (composition primitives), §9 (sagas & compensation).
 */

import { randomUUID } from "node:crypto";
import { execute, type ExecuteOptions, StoaExecutionError } from "./execute.js";
import type {
  CapabilityURN,
  PlanDeclaration,
  PlanResult,
  PlanStep,
  StepResult,
  StoaRuntime,
  LineageGraph,
  LineageNode,
  LineageEdge,
  Receipt,
  OnFailurePolicy,
} from "./types.js";

// ---------------------------------------------------------------------------
// Step builder
// ---------------------------------------------------------------------------

interface PendingStep {
  id: number;
  cap: CapabilityURN;
  input?: Record<string, unknown>;
  input_from?: Record<string, string>;
  fan_out?: string;
  depends_on?: number[];
  policy?: {
    max_retry?: number;
    require_human_confirmation?: boolean;
    preferred_region?: string;
  };
}

// ---------------------------------------------------------------------------
// Plan class
// ---------------------------------------------------------------------------

export class Plan {
  private readonly _planId: string;
  private readonly _steps: PendingStep[] = [];
  private _onFailure: OnFailurePolicy = "compensate";
  private _onPartialSuccess: OnFailurePolicy = "report_and_continue";
  private _budgetCeilingCents?: number;
  private _maxWallSeconds?: number;
  private _agentDid?: string;
  private _pendingFanOut?: string;

  constructor(planId?: string) {
    this._planId = planId ?? `plan_${randomUUID().slice(0, 8)}`;
  }

  /**
   * Add a step to the plan.
   *
   * @param cap - Capability URN
   * @param input - Static input (resolved at build time)
   * @param options - Additional step options
   */
  addStep(
    cap: CapabilityURN,
    input?: Record<string, unknown>,
    options?: {
      input_from?: Record<string, string>;
      depends_on?: number[];
      max_retry?: number;
      require_human_confirmation?: boolean;
      preferred_region?: string;
    }
  ): this {
    const stepId = this._steps.length + 1;
    const step: PendingStep = {
      id: stepId,
      cap,
      input,
      input_from: options?.input_from,
      depends_on: options?.depends_on,
      policy: {
        max_retry: options?.max_retry,
        require_human_confirmation: options?.require_human_confirmation,
        preferred_region: options?.preferred_region,
      },
    };

    // Attach pending fan_out to this step
    if (this._pendingFanOut) {
      step.fan_out = this._pendingFanOut;
      this._pendingFanOut = undefined;
    }

    this._steps.push(step);
    return this;
  }

  /**
   * Apply a fan-out JSONPath to the NEXT step added.
   * The step iterates over items at the given path in prior step output.
   *
   * @param jsonPath - JSONPath expression e.g. "$.steps[1].output.contacts"
   */
  fanOut(jsonPath: string): this {
    this._pendingFanOut = jsonPath;
    return this;
  }

  /**
   * Set the failure policy for the plan.
   */
  onFailure(policy: OnFailurePolicy): this {
    this._onFailure = policy;
    return this;
  }

  /**
   * Set the partial success policy.
   */
  onPartialSuccess(policy: OnFailurePolicy): this {
    this._onPartialSuccess = policy;
    return this;
  }

  /**
   * Set a hard budget ceiling in USD cents.
   */
  budget(ceilingCents: number): this {
    this._budgetCeilingCents = ceilingCents;
    return this;
  }

  /**
   * Set max wall-clock time in seconds.
   */
  maxWallSeconds(seconds: number): this {
    this._maxWallSeconds = seconds;
    return this;
  }

  /**
   * Set the agent DID (included in the plan declaration).
   */
  asAgent(did: string): this {
    this._agentDid = did;
    return this;
  }

  /**
   * Export the plan as a raw PlanDeclaration object.
   */
  toDeclaration(): PlanDeclaration {
    return {
      plan_id: this._planId,
      agent: this._agentDid,
      budget_ceiling_cents: this._budgetCeilingCents,
      max_wall_seconds: this._maxWallSeconds,
      steps: this._steps.map((s) => {
        const step: PlanStep = {
          id: s.id,
          cap: s.cap,
        };
        if (s.input) step.input = s.input;
        if (s.input_from) step.input_from = s.input_from;
        if (s.fan_out) step.fan_out = s.fan_out;
        if (s.depends_on) step.depends_on = s.depends_on;
        if (s.policy && Object.values(s.policy).some((v) => v !== undefined)) {
          step.policy = s.policy;
        }
        return step;
      }),
      on_failure: this._onFailure,
      on_partial_success: this._onPartialSuccess,
    };
  }

  /**
   * Execute the plan against a Stoa runtime.
   *
   * For v0, this executes steps sequentially in order. Fan-out and
   * parallel execution are declared but not yet parallelized client-side
   * (the Stoa Edge runtime handles parallelism server-side when using a
   * real Stoa endpoint).
   */
  async execute(
    runtime: StoaRuntime,
    options?: ExecuteOptions
  ): Promise<PlanResult> {
    const stepResults: StepResult[] = [];
    const allReceipts: Receipt[] = [];
    let totalCostCents = 0;
    let planStatus: PlanResult["status"] = "ok";
    const stepOutputs: Record<string | number, unknown> = {};

    for (const step of this._steps) {
      // Resolve input_from references (simple JSONPath on prior step outputs)
      const resolvedInput = resolveInput(step, stepOutputs);

      try {
        const result = await execute(
          runtime,
          {
            stoa: "1",
            cap: step.cap,
            input: resolvedInput,
            idem: `${this._agentDid ?? "agent"}:${this._planId}:step_${step.id}`,
            trace: {
              plan: this._planId,
              step: step.id,
            },
            budget: this._budgetCeilingCents
              ? { ceiling_cents: this._budgetCeilingCents }
              : undefined,
            policy: step.policy,
          },
          options
        );

        stepOutputs[step.id] = result.output;

        const stepResult: StepResult = {
          step_id: step.id,
          cap: step.cap,
          status: "ok",
          output: result.output,
          receipt: result.receipt,
          state_delta: result.state_delta,
          cost: result.cost,
        };
        stepResults.push(stepResult);

        if (result.receipt) {
          allReceipts.push(result.receipt);
        }
        if (result.cost) {
          totalCostCents += result.cost.actual_cents;
        }
      } catch (err: unknown) {
        const stoaErr =
          err instanceof StoaExecutionError
            ? err
            : new StoaExecutionError(
                "unknown_error",
                err instanceof Error ? err.message : String(err)
              );

        const stepResult: StepResult = {
          step_id: step.id,
          cap: step.cap,
          status: "error",
          error: {
            code: stoaErr.code,
            message: stoaErr.message,
            remediation: stoaErr.remediation,
            trace_id: stoaErr.trace_id,
            details: stoaErr.details,
          },
        };
        stepResults.push(stepResult);

        if (this._onFailure === "abort") {
          planStatus = "failed";
          break;
        } else if (this._onFailure === "compensate") {
          // Run compensation for completed steps in reverse
          await compensate(stepResults, runtime, options);
          planStatus = "compensated";
          break;
        } else if (this._onFailure === "report_and_continue") {
          planStatus = "partial";
        }
        // "ignore" just continues
      }
    }

    // Build lineage graph from all receipts
    const lineage = buildLineageFromSteps(stepResults);

    return {
      plan_id: this._planId,
      status: planStatus,
      steps: stepResults,
      receipts: allReceipts,
      total_cost_cents: totalCostCents,
      lineage,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a step's input by merging static `input` with `input_from` references.
 * Supports simple dot-path references like "$.steps[1].output.emails".
 */
function resolveInput(
  step: PendingStep,
  stepOutputs: Record<string | number, unknown>
): Record<string, unknown> {
  const base = { ...(step.input ?? {}) };

  if (!step.input_from) return base;

  for (const [key, path] of Object.entries(step.input_from)) {
    base[key] = resolveJsonPath(path, stepOutputs);
  }

  return base;
}

function resolveJsonPath(
  path: string,
  context: Record<string | number, unknown>
): unknown {
  // Handle "$.steps[N].output.field" style paths
  const match = path.match(/^\$\.steps\[(\d+)\]\.output(\.(.+))?$/);
  if (match) {
    const stepId = parseInt(match[1] ?? "0", 10);
    const fieldPath = match[3];
    const stepOut = context[stepId];
    if (!fieldPath) return stepOut;
    return getNestedField(stepOut, fieldPath.split("."));
  }
  // Fall back: return path as literal string
  return path;
}

function getNestedField(obj: unknown, keys: string[]): unknown {
  let cur = obj;
  for (const key of keys) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Run compensation for all successfully completed steps, in reverse order.
 */
async function compensate(
  stepResults: StepResult[],
  _runtime: StoaRuntime,
  _options?: ExecuteOptions
): Promise<void> {
  const completed = stepResults.filter((s) => s.status === "ok").reverse();
  for (const step of completed) {
    // In v0, compensation is declarative — the Stoa Edge handles it.
    // Client-side we just mark the step as compensated and log.
    step.status = "compensated";
    console.info(
      `[stoa plan] Compensation declared for step ${step.step_id} (${step.cap}). ` +
        "Stoa Edge will execute rollback via capability graph."
    );
  }
}

function buildLineageFromSteps(stepResults: StepResult[]): LineageGraph {
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];

  for (const step of stepResults) {
    if (step.status !== "ok") continue;

    // Add produced resource from state_delta
    if (step.state_delta) {
      nodes.push({
        resource: step.state_delta.resource,
        produced_by: step.cap,
        ts: Date.now(),
      });
    }
  }

  // Build edges from sequential dependencies
  for (let i = 1; i < stepResults.length; i++) {
    const prev = stepResults[i - 1];
    const curr = stepResults[i];
    if (!prev || !curr) continue;
    if (prev.status !== "ok" || curr.status !== "ok") continue;
    if (prev.state_delta && curr.state_delta) {
      edges.push({
        from: prev.state_delta.resource,
        to: curr.state_delta.resource,
        via: curr.cap,
      });
    }
  }

  return { nodes, edges };
}
