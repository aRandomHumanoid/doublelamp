// Startup, login and logout (05 §6). GET /me decides between the login screen, the app, and the
// offline shell.
import { api } from "../api/endpoints";
import { ApiError, setUnauthorizedHandler } from "../api/http";
import { connection } from "./socket";
import { resetLive, useApp } from "./store";

const SIGNED_OUT = "You were signed out. Sign in again to continue.";

export async function verifySession(): Promise<"ok" | "unauthorized" | "unreachable"> {
  try {
    const me = await api.me();
    useApp.setState({ session: me.session });
    return "ok";
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return "unauthorized";
    return "unreachable";
  }
}

function enterApp(): void {
  useApp.setState({ auth: "ready", authNotice: null });
  connection.start({ verify: verifySession, onUnauthorized: () => signedOut(SIGNED_OUT) });
}

export function signedOut(notice: string | null = SIGNED_OUT): void {
  connection.stop();
  resetLive();
  useApp.setState({ auth: "login", session: null, authNotice: notice });
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Checks the session; on failure keeps retrying every 5 s while the offline shell is shown. */
export async function boot(): Promise<void> {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  setUnauthorizedHandler(() => {
    if (useApp.getState().auth === "ready") signedOut(SIGNED_OUT);
  });
  const r = await verifySession();
  if (r === "ok") enterApp();
  else if (r === "unauthorized") useApp.setState({ auth: "login" });
  else {
    useApp.setState({ auth: "offline" });
    retryTimer = setTimeout(() => void boot(), 5000);
  }
}

export async function login(password: string, label?: string): Promise<void> {
  const r = await api.login(password, label);
  useApp.setState({ session: r.session });
  enterApp();
}

export async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    /* signed out locally either way */
  }
  signedOut(null);
}
