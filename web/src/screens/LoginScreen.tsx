// Login (06 A.1, 05 §6): one shared password, plus an optional "Name this device" label for the
// activity log and the list of signed-in browsers.
import { useState, type FormEvent } from "react";
import { LIMITS, loginRequestSchema } from "@doublelamp/protocol";
import { ApiError } from "../api/http";
import { BrandMark } from "../components/Icons";
import { KEYS, load, save } from "../lib/storage";
import { describeError } from "../live/names";
import { login } from "../live/session";
import { useApp } from "../live/store";

export function LoginScreen() {
  const notice = useApp((s) => s.authNotice);
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState(() => load<string>(KEYS.label, ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = label.trim() || undefined;
    const parsed = loginRequestSchema.safeParse({ password, label: name });
    if (!parsed.success) {
      setError(password ? (parsed.error.issues[0]?.message ?? "Check the form") : "Enter the password");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(password, name);
      save(KEYS.label, label.trim());
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) setError("Wrong password");
      else if (err instanceof ApiError && err.code === "rate_limited")
        setError("Too many attempts. Wait a few minutes, then try again.");
      else setError(describeError(err));
    }
  };

  return (
    <main className="login" id="main">
      <form className="login-card card" onSubmit={submit} noValidate>
        <div className="login-brand">
          <BrandMark size={44} />
          <h1>DoubleLamp</h1>
        </div>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {/* One shared password: a fixed hidden username lets password managers save it. */}
        <input type="text" name="username" autoComplete="username" value="doublelamp" readOnly hidden />
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            aria-invalid={!!error}
            aria-describedby="login-error"
          />
        </label>
        <label className="field">
          <span>
            Name this device <span className="muted">(optional)</span>
          </span>
          <input
            type="text"
            autoComplete="off"
            maxLength={LIMITS.nameMaxLength}
            placeholder="Kitchen iPad"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-describedby="label-hint"
          />
          <small id="label-hint" className="muted">
            Shown in the activity log and the list of signed-in browsers.
          </small>
        </label>
        <p id="login-error" className="error" role="alert">
          {error}
        </p>
        <button type="submit" className="btn btn-primary wide" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
