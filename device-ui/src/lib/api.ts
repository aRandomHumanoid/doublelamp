// Same-origin client for the lamp's local API (04 §3).
// - Every state-changing request is JSON with Content-Type: application/json (07 §4: others get 415).
// - The admin token lives in this module only: never in storage or cookies (07 §4.3).
// - Errors arrive as {error:{code,message,field?}} and become ApiError.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

const BASE = "/api/v1";

let token: string | null = null;
let loginHandler: (() => Promise<void>) | null = null;

export const session = {
  get token() {
    return token;
  },
  set(t: string | null) {
    token = t;
  },
  /** Sessions live in the lamp's RAM, so a reboot or OTA ends them. */
  clear() {
    token = null;
  },
};

/** The UI registers a function that asks for the admin password and logs in (or rejects). */
export function onLoginNeeded(fn: () => Promise<void>): void {
  loginHandler = fn;
}

const FALLBACK: Record<number, string> = {
  400: "The lamp didn't accept that.",
  401: "Login needed.",
  403: "Not allowed right now.",
  404: "Not found on this lamp.",
  409: "That conflicts with the lamp's current settings.",
  413: "That's too large for the lamp.",
  415: "The lamp rejected the request format.",
  421: "Open the lamp by its IP address or .local name.",
  429: "Too many attempts. Wait a minute and try again.",
  503: "The lamp is busy. Try again in a moment.",
};

export function errorFromBody(status: number, text: string): ApiError {
  let code = "http_" + status;
  let message = FALLBACK[status] || "The lamp answered with an error (" + status + ").";
  let field: string | undefined;
  try {
    const e = JSON.parse(text).error;
    if (e) {
      if (typeof e.code === "string") code = e.code;
      if (typeof e.message === "string" && e.message) message = e.message;
      if (typeof e.field === "string") field = e.field;
    }
  } catch {
    /* not JSON */
  }
  return new ApiError(status, code, message, field);
}

export interface ReqOpts {
  timeout?: number;
  /** Return the body as text instead of parsing JSON. */
  text?: boolean;
}

/** One request. No automatic re-login; see admin(). */
export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body === undefined ? {} : body);
  }
  if (token) headers.Authorization = "Bearer " + token;

  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (ctrl) ctrl.abort();
  }, opts.timeout || 10000);

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: payload,
      cache: "no-store",
      credentials: "same-origin",
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch {
    clearTimeout(timer);
    throw timedOut
      ? new ApiError(0, "timeout", "The lamp didn't answer in time.")
      : new ApiError(0, "network", "Can't reach the lamp.");
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    clearTimeout(timer);
    throw new ApiError(0, "network", "The connection to the lamp dropped.");
  }
  clearTimeout(timer);
  if (timedOut && !ctrl) throw new ApiError(0, "timeout", "The lamp didn't answer in time.");
  if (!res.ok) throw errorFromBody(res.status, text);
  if (opts.text) return text as unknown as T;
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as unknown as T;
  }
}

/** An admin request: on 401 the session is dropped, the password is asked for again, and the request retried once. */
export async function admin<T = unknown>(method: string, path: string, body?: unknown, opts?: ReqOpts): Promise<T> {
  if (!token && loginHandler) await loginHandler();
  try {
    return await api<T>(method, path, body, opts);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401 || !loginHandler) throw e;
    token = null;
    await loginHandler();
    return api<T>(method, path, body, opts);
  }
}

export async function login(password: string): Promise<void> {
  const r = await api<{ token: string; expires_in: number }>("POST", "/auth/login", { password });
  if (!r || typeof r.token !== "string") throw new ApiError(0, "invalid", "The lamp sent an unexpected answer.");
  token = r.token;
}

export async function logout(): Promise<void> {
  try {
    if (token) await api("POST", "/auth/logout", {});
  } finally {
    token = null;
  }
}

/** Firmware upload (04 §3 POST /ota): raw bytes as application/octet-stream, with upload progress. */
export function uploadFirmware(file: Blob, onProgress: (sent: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", BASE + "/ota");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.timeout = 300000;
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        const err = errorFromBody(xhr.status, xhr.responseText);
        if (xhr.status === 401) token = null;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "The upload was interrupted."));
    xhr.ontimeout = () => reject(new ApiError(0, "timeout", "The upload took too long."));
    xhr.send(file);
  });
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong.";
}
