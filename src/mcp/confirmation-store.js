import crypto from "node:crypto";
import { OutreachApiError } from "./errors.js";

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalize(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return String(value);
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function fingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function confirmationError(code, message) {
  return new OutreachApiError(message, { code });
}

export function createConfirmationStore({
  ttlSeconds = 600,
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  const ttlMs = Math.min(Math.max(Number(ttlSeconds) || 600, 60), 3_600) * 1_000;
  const plans = new Map();

  function prepare({ operation, payload, snapshot, summary, preview }) {
    const token = randomUUID();
    const expiresAt = now() + ttlMs;
    plans.set(token, {
      operation,
      payload: structuredClone(payload),
      snapshotFingerprint: fingerprint(snapshot),
      summary: String(summary || ""),
      preview: structuredClone(preview ?? { request: payload, current_state: snapshot }),
      expiresAt,
    });
    return {
      confirmation_token: token,
      operation,
      summary: String(summary || ""),
      expires_at: new Date(expiresAt).toISOString(),
      requires_confirmation: true,
      preview: structuredClone(preview ?? { request: payload, current_state: snapshot }),
    };
  }

  function claim({ token, operation, confirm }) {
    const plan = plans.get(token);
    if (!plan) throw confirmationError("confirmation_not_found", "Confirmation plan was not found or was already used");
    plans.delete(token);
    if (confirm !== true) throw confirmationError("confirmation_required", "Explicit human confirmation is required");
    if (now() > plan.expiresAt) throw confirmationError("confirmation_expired", "Confirmation plan has expired");
    if (operation !== plan.operation) {
      throw confirmationError("confirmation_operation_mismatch", "Confirmation plan does not match this operation");
    }
    return {
      operation: plan.operation,
      payload: structuredClone(plan.payload),
      snapshotFingerprint: plan.snapshotFingerprint,
      summary: plan.summary,
      expiresAt: plan.expiresAt,
    };
  }

  function verify({ plan, currentSnapshot }) {
    if (fingerprint(currentSnapshot) !== plan.snapshotFingerprint) {
      throw confirmationError("confirmation_state_changed", "Outreach data changed after preparation; prepare a new plan");
    }
    return plan;
  }

  function consume({ token, operation, currentSnapshot, confirm }) {
    return verify({ plan: claim({ token, operation, confirm }), currentSnapshot });
  }

  function inspect({ token, operation }) {
    const plan = plans.get(token);
    if (!plan) throw confirmationError("confirmation_not_found", "Confirmation plan was not found or was already used");
    if (now() > plan.expiresAt) {
      plans.delete(token);
      throw confirmationError("confirmation_expired", "Confirmation plan has expired");
    }
    if (operation !== plan.operation) {
      throw confirmationError("confirmation_operation_mismatch", "Confirmation plan does not match this operation");
    }
    return {
      operation: plan.operation,
      payload: structuredClone(plan.payload),
      summary: plan.summary,
      expiresAt: plan.expiresAt,
    };
  }

  return { prepare, inspect, claim, verify, consume };
}
