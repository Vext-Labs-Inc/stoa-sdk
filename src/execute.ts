/**
 * Execution engine — posts to a Stoa/1 endpoint.
 *
 * Handles:
 * - idem key generation
 * - Exponential backoff retry on transient errors (backoff / service_unavailable)
 * - Typed error surfacing with remediation hints
 * - Acting-As header propagation
 *
 * Reference: STOA.md §5, §6.
 */

import { idemKey } from "./util/hash.js";
import {
  StoaRequestSchema,
  AnyStoaResponseSchema,
  type StoaRequestInput,
  type StoaResponseOutput,
  type StoaErrorEnvelopeOutput,
} from "./wire.js";
import type { StoaRuntime, Receipt, StateDelta, Cost } from "./types.js";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class StoaExecutionError extends Error {
  readonly code: string;
  readonly remediation?: StoaErrorEnvelopeOutput["error"]["remediation"];
  readonly trace_id?: string;
  readonly details?: Record<string, unknown>;
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    opts?: {
      remediation?: StoaErrorEnvelopeOutput["error"]["remediation"];
      trace_id?: string;
      details?: Record<string, unknown>;
      status?: number;
    }
  ) {
    super(message);
    this.name = "StoaExecutionError";
    this.code = code;
    this.remediation = opts?.remediation;
    this.trace_id = opts?.trace_id;
    this.details = opts?.details;
    this.status = opts?.status;
  }
}

// ---------------------------------------------------------------------------
// Execute options
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  /** Maximum number of retry attempts on transient errors. Default: 3 */
  maxRetry?: number;
  /** Initial retry delay in ms. Default: 500 */
  retryDelayMs?: number;
  /** Acting-As header fields for audit trail */
  actingAs?: {
    user_id?: string;
    agent_id?: string;
    session_id?: string;
    trace_id?: string;
  };
  /** If true, throw on partial non-ok responses. Default: false */
  strictMode?: boolean;
}

export interface ExecuteResult {
  output: unknown;
  receipt?: Receipt;
  state_delta?: StateDelta;
  cost?: Cost;
  warnings?: StoaResponseOutput["warnings"];
  continuation?: string | null;
}

// ---------------------------------------------------------------------------
// Core execute function
// ---------------------------------------------------------------------------

/**
 * Execute a single Stoa/1 capability call.
 *
 * @param runtime - Endpoint configuration and auth
 * @param request - The Stoa/1 request envelope (will be validated via Zod)
 * @param options - Retry, acting-as, and strictness options
 */
export async function execute(
  runtime: StoaRuntime,
  request: StoaRequestInput,
  options: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const maxRetry = options.maxRetry ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 500;

  // Validate request envelope
  const parsed = StoaRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new StoaExecutionError(
      "validation_failed",
      `Invalid Stoa/1 request: ${parsed.error.message}`,
      { details: { zod_issues: parsed.error.issues } }
    );
  }

  const envelope = parsed.data;

  // Inject idem key if not present
  if (!envelope.idem && envelope.trace) {
    const planId = String(envelope.trace.plan ?? "plan");
    const stepId = String(envelope.trace.step ?? "0");
    const agentId = envelope.agent?.issuer ?? "agent";
    (envelope as StoaRequestInput).idem = idemKey(agentId, planId, stepId);
  }

  let attempt = 0;
  let lastError: StoaExecutionError | undefined;

  while (attempt <= maxRetry) {
    try {
      const result = await doRequest(runtime, envelope, options);
      return result;
    } catch (err: unknown) {
      if (!(err instanceof StoaExecutionError)) {
        // Network / fetch errors — wrap them
        const msg = err instanceof Error ? err.message : String(err);
        lastError = new StoaExecutionError("network_error", msg);
      } else {
        lastError = err;
      }

      const hint = lastError.remediation?.hint;
      const isRetryable =
        hint === "backoff" ||
        lastError.code === "service_unavailable" ||
        lastError.code === "rate_limited" ||
        lastError.code === "network_error";

      if (!isRetryable || attempt >= maxRetry) {
        throw lastError;
      }

      // Exponential backoff
      const retryAfter = lastError.remediation?.retry_after_ms ?? retryDelayMs * Math.pow(2, attempt);
      await sleep(retryAfter);
      attempt++;
    }
  }

  throw lastError ?? new StoaExecutionError("unknown_error", "Execution failed");
}

// ---------------------------------------------------------------------------
// Internal HTTP fetch
// ---------------------------------------------------------------------------

async function doRequest(
  runtime: StoaRuntime,
  envelope: StoaRequestInput,
  options: ExecuteOptions
): Promise<ExecuteResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (runtime.authToken) {
    headers["Authorization"] = `Bearer ${runtime.authToken}`;
  }
  if (runtime.agentJwt) {
    headers["X-Stoa-Agent-JWT"] = runtime.agentJwt;
  }

  // Acting-As header for audit trail
  if (options.actingAs) {
    const parts: string[] = [];
    const a = options.actingAs;
    if (a.user_id) parts.push(`user_id=${a.user_id}`);
    if (a.agent_id) parts.push(`agent_id=${a.agent_id}`);
    if (a.session_id) parts.push(`session_id=${a.session_id}`);
    if (a.trace_id) parts.push(`trace_id=${a.trace_id}`);
    if (parts.length > 0) {
      headers["Acting-As"] = parts.join("; ");
    }
  }

  // Idempotency key header
  if (envelope.idem) {
    headers["Idempotency-Key"] = envelope.idem;
  }

  const res = await fetch(runtime.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
  });

  const body: unknown = await res.json().catch(() => ({
    stoa: "1",
    status: "error",
    error: {
      code: "parse_error",
      message: `Server returned non-JSON response (HTTP ${res.status})`,
    },
  }));

  const parsed = AnyStoaResponseSchema.safeParse(body);

  if (!parsed.success) {
    // Server returned something that doesn't match the Stoa/1 envelope
    throw new StoaExecutionError(
      "protocol_error",
      `Server response does not conform to Stoa/1 envelope: ${parsed.error.message}`,
      { status: res.status }
    );
  }

  const response = parsed.data;

  if (response.status === "error") {
    const errEnv = response as StoaErrorEnvelopeOutput;
    throw new StoaExecutionError(
      errEnv.error.code,
      errEnv.error.message,
      {
        remediation: errEnv.error.remediation,
        trace_id: errEnv.error.trace_id,
        details: errEnv.error.details,
        status: res.status,
      }
    );
  }

  const okResponse = response as StoaResponseOutput;
  return {
    output: okResponse.output,
    receipt: okResponse.receipt,
    state_delta: okResponse.state_delta,
    cost: okResponse.cost,
    warnings: okResponse.warnings,
    continuation: okResponse.continuation,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
