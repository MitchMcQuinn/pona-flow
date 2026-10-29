/**
 * Built-in auth screens: first-run setup, sign-in, and invite-based sign-up.
 *
 * Rendered by `main.tsx` in local mode before the app shell mounts. They share one card
 * layout (`.authRoot` / `.authCard` in styles.css) and the same submit plumbing; the
 * server owns every rule (password policy, invite requirement, throttling) and the
 * error message it returns is shown verbatim.
 */
import { useState, type FormEvent } from "react";
import type { Me } from "../../state/types";
import { login, setupFirstAccount, signup, type Credentials } from "../../services/localAuth";
import logoUrl from "../../../../assets/pona-flow-white.svg";
import "./auth.css";

type Mode = "setup" | "login" | "signup";

interface AuthPagesProps {
  /** Start on the setup page (fresh instance) or the sign-in page. */
  initialMode: "setup" | "login";
  openSignup: boolean;
  onSignedIn: (me: Me) => void;
}

const COPY: Record<Mode, { title: string; blurb: string; submit: string; busy: string }> = {
  setup: {
    title: "set up pona flow",
    blurb:
      "Create the first account for this instance. It becomes the instance administrator, " +
      "which can create spaces and invite everyone else.",
    submit: "Create admin account",
    busy: "Creating..."
  },
  login: {
    title: "sign in",
    blurb: "Use the email and password for your account on this instance.",
    submit: "Sign in",
    busy: "Signing in..."
  },
  signup: {
    title: "create your account",
    blurb:
      "Use the email address a space admin invited. Your account is attached to that " +
      "invitation as soon as it is created.",
    submit: "Create account",
    busy: "Creating..."
  }
};

export function AuthPages({ initialMode, openSignup, onSignedIn }: AuthPagesProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = COPY[mode];
  const wantsName = mode !== "login";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const credentials: Credentials = {
      email: email.trim(),
      password,
      displayName: displayName.trim() || undefined
    };
    try {
      const action = mode === "setup" ? setupFirstAccount : mode === "signup" ? signup : login;
      const me = await action(credentials);
      onSignedIn(me);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setPassword("");
  }

  return (
    <div className="appRoot authRoot">
      <form className="authCard" onSubmit={handleSubmit} noValidate>
        <img className="authLogo" src={logoUrl} alt="" aria-hidden="true" />
        <h1>{copy.title}</h1>
        <p className="muted">{copy.blurb}</p>

        {wantsName ? (
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How you want to appear to teammates"
              disabled={busy}
            />
          </label>
        ) : null}

        <div className="authFields">
          <div className="authInlineField">
            <span className="authInlineTip" />
            <label className="authInlineLabel" htmlFor="auth-email">
              email:
            </label>
            <div className="authInlineControl">
              <input
                id="auth-email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>
          <div className="authInlineField">
            <span className="authInlineTip" />
            <label className="authInlineLabel" htmlFor="auth-password">
              password:
            </label>
            <div className="authInlineControl">
              <input
                id="auth-password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={mode === "login" ? undefined : 10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>
        </div>
        {mode !== "login" ? <small className="muted">At least 10 characters.</small> : null}

        {error ? (
          <p className="authError" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="btnPrimary" disabled={busy || !email.trim() || !password}>
          {busy ? copy.busy : copy.submit}
        </button>

        {mode === "login" ? (
          <p className="authSwitch muted">
            {openSignup ? "New here?" : "Have an invitation?"}{" "}
            <button type="button" className="linkButton" onClick={() => switchMode("signup")}>
              Create an account
            </button>
          </p>
        ) : null}
        {mode === "signup" ? (
          <p className="authSwitch muted">
            Already have an account?{" "}
            <button type="button" className="linkButton" onClick={() => switchMode("login")}>
              Sign in
            </button>
          </p>
        ) : null}
      </form>
    </div>
  );
}

/** Shown when `/api/auth/status` itself cannot be reached (API down or misconfigured). */
export function ApiUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="appRoot authRoot">
      <div className="authCard">
        <h1>cannot reach the pona flow api</h1>
        <p className="muted">
          The browser loaded the app but <code>/api/auth/status</code> did not answer. If you
          just started the server, give it a few seconds; otherwise check that the API process
          is running and that this page is served from the same origin.
        </p>
        <button type="button" className="btnPrimary" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}
