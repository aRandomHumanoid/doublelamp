// fetch wrapper for /api/v1 (04 §7.1): JSON in and out, the `{error:{code,message,field?}}` body as
// ApiError, and a global hook for 401 so any request can send the app back to the login screen.
import type { ErrorBody } from "@doublelamp/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export interface RequestOptions {
  /** Don't treat 401 as "session ended" (login and the startup /me check handle it themselves). */
  quiet401?: boolean;
  signal?: AbortSignal;
}

const BASE = "/api/v1";

function codeForStatus(status: number): string {
  if (status === 401) return "auth_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  if (status === 503) return "busy";
  if (status >= 500) return "server_error";
  return "invalid";
}

function toResult<T>(status: number, statusText: string, text: string, opts: RequestOptions): T {
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (status >= 200 && status < 300) return (status === 204 ? undefined : json) as T;
  const body = (json as Partial<ErrorBody> | null)?.error;
  const message = body?.message || (status >= 500 ? `Server error (${status})` : statusText || `HTTP ${status}`);
  const err = new ApiError(status, body?.code ?? codeForStatus(status), message, body?.field);
  if (status === 401 && !opts.quiet401) onUnauthorized();
  throw err;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: payload,
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", "No connection to server");
  }
  return toResult<T>(res.status, res.statusText, await res.text(), opts);
}

/** Raw binary upload with progress (fetch has no upload progress, so this uses XHR). */
export function upload<T>(path: string, file: Blob, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", BASE + path);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        resolve(toResult<T>(xhr.status, xhr.statusText, xhr.responseText, {}));
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "No connection to server"));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled"));
    xhr.send(file);
  });
}
