/**
 * Tests for Plan builder and execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Plan } from "../src/plan.js";
import { StoaExecutionError } from "../src/execute.js";
import type { CapabilityURN, StoaRuntime } from "../src/types.js";

const CAP_QUERY = "urn:stoa:cap:posthog.events.query@2.0.0" as CapabilityURN;
const CAP_CREATE = "urn:stoa:cap:hubspot.contacts.create@2.3.1" as CapabilityURN;
const CAP_CALENDAR = "urn:stoa:cap:cal.events.create@1.5.2" as CapabilityURN;

const MOCK_RUNTIME: StoaRuntime = {
  endpoint: "https://test.stoa.internal/v1/execute",
};

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

describe("Plan construction", () => {
  it("creates a plan with a custom plan_id", () => {
    const plan = new Plan("plan_test_001");
    const decl = plan.toDeclaration();
    expect(decl.plan_id).toBe("plan_test_001");
  });

  it("generates a plan_id when not provided", () => {
    const plan = new Plan();
    const decl = plan.toDeclaration();
    expect(decl.plan_id).toMatch(/^plan_/);
  });

  it("adds steps in order", () => {
    const plan = new Plan("plan_steps")
      .addStep(CAP_QUERY, { event: "signup" })
      .addStep(CAP_CREATE, { email: "test@example.com" });

    const decl = plan.toDeclaration();
    expect(decl.steps).toHaveLength(2);
    expect(decl.steps[0]?.id).toBe(1);
    expect(decl.steps[1]?.id).toBe(2);
    expect(decl.steps[0]?.cap).toBe(CAP_QUERY);
    expect(decl.steps[1]?.cap).toBe(CAP_CREATE);
  });

  it("attaches fan_out to the next step", () => {
    const plan = new Plan("plan_fanout")
      .addStep(CAP_QUERY, { event: "signup" })
      .fanOut("$.steps[1].output.contacts")
      .addStep(CAP_CALENDAR, { duration_min: 30 });

    const decl = plan.toDeclaration();
    expect(decl.steps[1]?.fan_out).toBe("$.steps[1].output.contacts");
    expect(decl.steps[0]?.fan_out).toBeUndefined();
  });

  it("sets onFailure policy", () => {
    const plan = new Plan("plan_fail").onFailure("abort");
    expect(plan.toDeclaration().on_failure).toBe("abort");
  });

  it("sets budget ceiling", () => {
    const plan = new Plan("plan_budget").budget(500);
    expect(plan.toDeclaration().budget_ceiling_cents).toBe(500);
  });

  it("sets agent DID", () => {
    const plan = new Plan("plan_agent").asAgent("did:web:hive.vext.ai");
    expect(plan.toDeclaration().agent).toBe("did:web:hive.vext.ai");
  });

  it("sets step-level policy", () => {
    const plan = new Plan("plan_policy").addStep(CAP_CREATE, {}, {
      max_retry: 2,
      require_human_confirmation: true,
    });

    const step = plan.toDeclaration().steps[0];
    expect(step?.policy?.max_retry).toBe(2);
    expect(step?.policy?.require_human_confirmation).toBe(true);
  });

  it("sets input_from references", () => {
    const plan = new Plan("plan_refs")
      .addStep(CAP_QUERY, { event: "signup" })
      .addStep(CAP_CREATE, {}, {
        input_from: { emails: "$.steps[1].output.distinct_emails" },
      });

    const step2 = plan.toDeclaration().steps[1];
    expect(step2?.input_from?.emails).toBe("$.steps[1].output.distinct_emails");
  });
});

// ---------------------------------------------------------------------------
// Plan execution (mocked fetch)
// ---------------------------------------------------------------------------

describe("Plan execution", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeOkResponse(output: unknown) {
    return new Response(
      JSON.stringify({
        stoa: "1",
        status: "ok",
        output,
        receipt: {
          alg: "ES256",
          sig: "test-sig",
          vendor_did: "did:web:test.vendor.com",
          ts: Math.floor(Date.now() / 1000),
          cap: CAP_QUERY,
          input_hash: "sha256:0xabc",
          output_hash: "sha256:0xdef",
          merkle_root: "0x9f",
          merkle_proof: [],
        },
        cost: {
          actual_cents: 5,
          breakdown: [{ kind: "vendor.api", amount_cents: 5 }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  function makeErrorResponse(code: string, message: string, hint: string) {
    return new Response(
      JSON.stringify({
        stoa: "1",
        status: "error",
        error: {
          code,
          message,
          remediation: { hint, retry_after_ms: null },
          trace_id: "trc_test_001",
        },
      }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  it("executes a single-step plan successfully", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ contacts: [{ id: "1" }] }));

    const plan = new Plan("plan_ok").addStep(CAP_QUERY, { event: "signup" });
    const result = await plan.execute(MOCK_RUNTIME, { maxRetry: 0 });

    expect(result.status).toBe("ok");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe("ok");
    expect(result.steps[0]?.output).toEqual({ contacts: [{ id: "1" }] });
    expect(result.total_cost_cents).toBe(5);
    expect(result.receipts).toHaveLength(1);
  });

  it("executes a multi-step plan and accumulates costs", async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ emails: ["a@b.com"] }))
      .mockResolvedValueOnce(makeOkResponse({ id: "contact_1" }));

    const plan = new Plan("plan_multi")
      .addStep(CAP_QUERY, { event: "signup" })
      .addStep(CAP_CREATE, { email: "a@b.com" });

    const result = await plan.execute(MOCK_RUNTIME, { maxRetry: 0 });

    expect(result.status).toBe("ok");
    expect(result.steps).toHaveLength(2);
    expect(result.total_cost_cents).toBe(10); // 5 + 5
  });

  it("handles step failure with 'abort' policy", async () => {
    fetchMock
      .mockResolvedValueOnce(makeErrorResponse("rate_limited", "Too many requests", "backoff"))
      .mockResolvedValueOnce(makeOkResponse({ id: "contact_1" }));

    const plan = new Plan("plan_abort")
      .onFailure("abort")
      .addStep(CAP_QUERY, { event: "signup" })
      .addStep(CAP_CREATE, { email: "a@b.com" });

    const result = await plan.execute(MOCK_RUNTIME, { maxRetry: 0 });

    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(1); // Aborted after first failure
    expect(result.steps[0]?.status).toBe("error");
    // Second step should not have been called
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles step failure with 'report_and_continue' policy", async () => {
    fetchMock
      .mockResolvedValueOnce(makeErrorResponse("not_found", "Resource not found", "permanent-failure"))
      .mockResolvedValueOnce(makeOkResponse({ id: "contact_2" }));

    const plan = new Plan("plan_continue")
      .onFailure("report_and_continue")
      .addStep(CAP_QUERY, { event: "signup" })
      .addStep(CAP_CREATE, { email: "b@b.com" });

    const result = await plan.execute(MOCK_RUNTIME, { maxRetry: 0 });

    expect(result.status).toBe("partial");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[1]?.status).toBe("ok");
  });

  it("handles step failure with 'compensate' policy", async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ id: "contact_1" })) // step 1 ok
      .mockResolvedValueOnce(
        makeErrorResponse("validation_failed", "Bad input", "fix-input-and-retry")
      ); // step 2 fails

    const plan = new Plan("plan_compensate")
      .onFailure("compensate")
      .addStep(CAP_CREATE, { email: "ok@b.com" })
      .addStep(CAP_CALENDAR, { duration_min: 30 });

    const result = await plan.execute(MOCK_RUNTIME, { maxRetry: 0 });

    expect(result.status).toBe("compensated");
    // Step 1 should be marked compensated
    expect(result.steps.some((s) => s.status === "compensated")).toBe(true);
  });

  it("sends Idempotency-Key header", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({}));

    const plan = new Plan("plan_idem")
      .asAgent("did:web:hive.vext.ai")
      .addStep(CAP_QUERY, { event: "signup" });

    await plan.execute(MOCK_RUNTIME, { maxRetry: 0 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toContain("plan_idem");
  });

  it("throws StoaExecutionError for non-Stoa/1 responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>Error</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      })
    );

    const plan = new Plan("plan_proto_err").addStep(CAP_QUERY, {});

    const result = await plan.execute(MOCK_RUNTIME, { maxRetry: 0 });
    // The step should fail with a protocol_error
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error?.code).toMatch(/protocol_error|parse_error|network_error/);
  });
});
