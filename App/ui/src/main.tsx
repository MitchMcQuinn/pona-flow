import React, { useCallback, useEffect, useLayoutEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider, RedirectToSignIn, Show, useAuth } from "@clerk/react";
import App from "./App";
import { MeshBackground } from "./components/MeshBackground";
import { ToastProvider } from "./components/Toast";
import { ApiUnreachable, AuthPages } from "./components/auth/AuthPages";
import { fetchMe } from "./services/api";
import {
  installAuthFetch,
  setCookieSessionMode,
  setTokenGetter,
  setUnauthorizedHandler
} from "./services/authFetch";
import { fetchAuthStatus, setResolvedAuthMode, type AuthStatus } from "./services/authMode";
import { LocalAuthContext } from "./services/clerkAuth";
import { logout } from "./services/localAuth";
import type { Me } from "./state/types";

const E2E_SKIP_AUTH_REDIRECT =
  (import.meta.env.VITE_E2E_SKIP_AUTH_REDIRECT as string | undefined) === "true";

// Install the global fetch interceptor once, before any API call can fire.
installAuthFetch();

/** App content shared by every authenticated render path. */
function AppShell() {
  return (
    <>
      <MeshBackground />
      <div className="appShell">
        <ToastProvider>
          <App />
        </ToastProvider>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Clerk mode
// ---------------------------------------------------------------------------

/**
 * Registers the Clerk token getter with the fetch interceptor so every `/api/*`
 * request carries a fresh session token. Rendered inside Show when="signed-in".
 */
function ClerkAuthenticatedApp() {
  const { getToken, signOut, isLoaded } = useAuth();

  // Register before child useEffects run (App fetches on mount). useLayoutEffect on
  // the parent runs after children in React's tree order, so we also set the getter
  // synchronously on each render to cover the first paint.
  setTokenGetter(() => getToken());

  useLayoutEffect(() => {
    setTokenGetter(() => getToken());
  }, [getToken]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // A 401 with a token means the session is no longer valid; bounce to sign-in.
      void signOut();
    });
    return () => {
      setTokenGetter(null);
      setUnauthorizedHandler(null);
    };
  }, [getToken, signOut]);

  if (!isLoaded) {
    return null;
  }

  return <AppShell />;
}

/**
 * Empty shell rendered during E2E runs so Clerk loads on localhost without redirecting
 * to the hosted Account Portal (which breaks cy.window() / cy.clerkSignIn).
 */
function E2EAuthShell() {
  return <div data-e2e-auth-shell hidden aria-hidden="true" />;
}

function ClerkRoot({ publishableKey }: { publishableKey: string }) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <Show
        when="signed-in"
        fallback={E2E_SKIP_AUTH_REDIRECT ? <E2EAuthShell /> : <RedirectToSignIn />}
      >
        <ClerkAuthenticatedApp />
      </Show>
    </ClerkProvider>
  );
}

// ---------------------------------------------------------------------------
// Local (built-in) mode
// ---------------------------------------------------------------------------

type LocalPhase =
  | { kind: "probing" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "app"; me: Me };

function LocalRoot({ status }: { status: AuthStatus }) {
  const [phase, setPhase] = useState<LocalPhase>(
    status.setupRequired ? { kind: "setup" } : { kind: "probing" }
  );

  // Probe for an existing session (cookie) or the development bypass.
  useEffect(() => {
    if (phase.kind !== "probing") return;
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (!cancelled) setPhase({ kind: "app", me });
      })
      .catch(() => {
        if (!cancelled) setPhase({ kind: "login" });
      });
    return () => {
      cancelled = true;
    };
  }, [phase.kind]);

  const signOut = useCallback(async () => {
    await logout();
    setPhase({ kind: "login" });
  }, []);

  // Any 401 on a non-auth API call while signed in means the session expired or was
  // revoked server-side: fall back to the sign-in page.
  useEffect(() => {
    setCookieSessionMode(true);
    setUnauthorizedHandler(() => setPhase({ kind: "login" }));
    return () => {
      setUnauthorizedHandler(null);
      setCookieSessionMode(false);
    };
  }, []);

  if (phase.kind === "probing") {
    return null;
  }
  if (phase.kind === "setup" || phase.kind === "login") {
    return (
      <AuthPages
        initialMode={phase.kind}
        openSignup={status.openSignup}
        onSignedIn={(me) => setPhase({ kind: "app", me })}
      />
    );
  }
  return (
    <LocalAuthContext.Provider value={{ me: phase.me, signOut }}>
      <AppShell />
    </LocalAuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const root = ReactDOM.createRoot(document.getElementById("root")!);

function boot(): void {
  fetchAuthStatus()
    .then((status) => {
      setResolvedAuthMode(status.mode);
      if (status.mode === "clerk") {
        const key =
          status.clerkPublishableKey ||
          (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ||
          "";
        if (!key) {
          throw new Error(
            "The server runs in Clerk mode but no publishable key is configured. " +
              "Set CLERK_PUBLISHABLE_KEY in the server environment."
          );
        }
        root.render(
          <React.StrictMode>
            <ClerkRoot publishableKey={key} />
          </React.StrictMode>
        );
        return;
      }
      root.render(
        <React.StrictMode>
          <LocalRoot status={status} />
        </React.StrictMode>
      );
    })
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error("pona flow boot failed:", error);
      root.render(
        <React.StrictMode>
          <ApiUnreachable onRetry={boot} />
        </React.StrictMode>
      );
    });
}

boot();
