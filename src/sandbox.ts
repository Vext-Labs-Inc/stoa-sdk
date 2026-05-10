/**
 * Sandbox — execute a plan against recorded vendor-response snapshots.
 *
 * No real side effects. For v0 accepts a MockVendor that returns canned
 * responses keyed by capability URN.
 *
 * Reference: STOA.md §16 (sandbox, replay, lineage).
 */

import { Plan } from "./plan.js";
import type {
  CapabilityURN,
  PlanResult,
  StoaRuntime,
  Receipt,
} from "./types.js";
import type { StoaResponseOutput } from "./wire.js";
import { hashJson } from "./util/hash.js";

// ---------------------------------------------------------------------------
// Mock vendor
// ---------------------------------------------------------------------------

export type MockResponse =
  | { status: "ok"; output: unknown; receipt?: Partial<Receipt> }
  | { status: "error"; code: string; message: string };

export type MockVendor = Map<CapabilityURN, MockResponse | ((input: unknown) => MockResponse)>;

// ---------------------------------------------------------------------------
// Sandbox runtime
// ---------------------------------------------------------------------------

/**
 * A fake StoaRuntime that intercepts fetch calls and returns mock responses.
 * Injects itself as the global fetch during plan execution.
 */
class SandboxRuntime {
  private _vendor: MockVendor;
  private _snapshotDate: string;
  private _callLog: Array<{ cap: CapabilityURN; input: unknown; output: unknown }> = [];

  constructor(vendor: MockVendor, snapshotDate: string) {
    this._vendor = vendor;
    this._snapshotDate = snapshotDate;
  }

  get callLog() {
    return this._callLog;
  }

  makeRuntime(): StoaRuntime {
    return { endpoint: "https://sandbox.stoa.internal/v1/execute" };
  }

  /**
   * Intercept a Stoa request and return a canned response.
   * Called by the patched fetch during sandbox execution.
   */
  handleRequest(body: {
    cap: CapabilityURN;
    input: Record<string, unknown>;
  }): StoaResponseOutput {
    const cap = body.cap;
    const mockEntry = this._vendor.get(cap);

    let response: MockResponse;
    if (!mockEntry) {
      response = {
        status: "error",
        code: "not_found",
        message: `No mock registered for capability ${cap}`,
      };
    } else if (typeof mockEntry === "function") {
      response = mockEntry(body.input);
    } else {
      response = mockEntry;
    }

    this._callLog.push({ cap, input: body.input, output: response });

    if (response.status === "error") {
      return {
        stoa: "1",
        status: "ok", // We return ok wrapper but the error is surfaced in output
        output: {
          __stoa_sandbox_error__: true,
          code: response.code,
          message: response.message,
        },
      };
    }

    // Build a synthetic receipt
    const syntheticReceipt: Receipt = {
      alg: "ES256",
      sig: "sandbox-sig",
      vendor_did: "did:web:sandbox.stoa.internal",
      ts: Math.floor(Date.now() / 1000),
      cap,
      input_hash: hashJson(body.input),
      output_hash: hashJson(response.output),
      merkle_root: `sandbox-root-${this._snapshotDate}`,
      merkle_proof: [],
      ...response.receipt,
    };

    return {
      stoa: "1",
      status: "ok",
      output: response.output,
      receipt: syntheticReceipt,
      cost: {
        actual_cents: 0,
        breakdown: [{ kind: "sandbox.simulated", amount_cents: 0 }],
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Sandbox.run
// ---------------------------------------------------------------------------

export class Sandbox {
  /**
   * Execute a Plan against a recorded MockVendor snapshot.
   *
   * @param plan - A built Plan instance
   * @param snapshotDate - ISO date string for the snapshot (e.g. "2026-05-10")
   * @param vendor - Map of capability URN → MockResponse (or function)
   */
  static async run(
    plan: Plan,
    snapshotDate: string,
    vendor: MockVendor
  ): Promise<SandboxResult> {
    const sandbox = new SandboxRuntime(vendor, snapshotDate);
    const runtime = sandbox.makeRuntime();

    // Patch global fetch to intercept calls to the sandbox endpoint
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.includes("sandbox.stoa.internal")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          cap: CapabilityURN;
          input: Record<string, unknown>;
        };
        const responseBody = sandbox.handleRequest(body);
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    };

    let result: PlanResult;
    try {
      result = await plan.execute(runtime, {
        maxRetry: 0, // No retries in sandbox
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    return {
      planResult: result,
      callLog: sandbox.callLog,
      snapshotDate,
    };
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SandboxResult {
  planResult: PlanResult;
  callLog: Array<{ cap: CapabilityURN; input: unknown; output: unknown }>;
  snapshotDate: string;
}
