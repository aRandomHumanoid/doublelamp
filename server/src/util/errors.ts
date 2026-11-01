// REST error bodies: {"error": {"code", "message", "field"?}} with statuses per 04 §3 / §8.
import type { ZodType, ZodTypeDef } from "zod";
import type { ErrorCode } from "@doublelamp/protocol";

/** Protocol error codes plus the two pairing-specific ones from 04 §4.5. */
export type ApiErrorCode = ErrorCode | "invalid_code" | "code_expired";

const STATUS: Record<string, number> = {
  invalid: 400,
  unknown_effect: 400,
  unsupported: 400,
  invalid_code: 400,
  auth_required: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  managed_by_server: 409,
  offline: 409,
  code_expired: 410,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
  busy: 503,
};

export function statusFor(code: string): number {
  return STATUS[code] ?? 400;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly field?: string,
    status?: number,
  ) {
    super(message);
    this.status = status ?? statusFor(code);
  }
}

export interface ErrorBody {
  error: { code: string; message: string; field?: string };
}

export function errorBody(code: string, message: string, field?: string): ErrorBody {
  return { error: field ? { code, message, field } : { code, message } };
}

/** Validates `data` with a zod schema, throwing a 400 `invalid` ApiError that names the failing field. */
export function parseBody<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue?.path.length ? issue.path.join(".") : undefined;
  const message = issue ? (field ? `${field}: ${issue.message}` : issue.message) : "invalid request";
  throw new ApiError("invalid", message, field);
}
