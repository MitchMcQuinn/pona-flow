import React, { useEffect, useLayoutEffect } from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider, RedirectToSignIn, Show, useAuth } from "@clerk/react";
import App from "./App";
import { MeshBackground } from "./components/MeshBackground";
import { ToastProvider } from "./components/Toast";
import { installAuthFetch, setTokenGetter, setUnauthorizedHandler } from "./services/authFetch";
import { AUTH_DISABLED } from "./services/authMode";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const E2E_SKIP_AUTH_REDIRECT =
  (import.meta.env.VITE_E2E_SKIP_AUTH_REDIRECT as string | undefined) === "true";

if (!AUTH_DISABLED && !PUBLISHABLE_KEY) {
  // Fail loudly during development so the missing key is obvious.
  throw new Error(
    "Missing VITE_CLERK_PUBLISHABLE_KEY. Set it in App/ui/.env (see .env.example)."
  );
}

// Install the global fetch interceptor once, before any API call can fire.
installAuthFetch();

/** App content shared by the authenticated and auth-disabled render paths. */
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

/**
 * Registers the Clerk token getter with the fetch interceptor so every `/api/*`
 * request carries a fresh session token. Rendered inside Show when="signed-in".
 */
function AuthenticatedApp() {
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

const root = ReactDOM.createRoot(document.getElementById("root")!);

if (AUTH_DISABLED) {
  // Local development bypass: no Clerk provider, no sign-in redirect. Requests go out
  // without a bearer token; the backend's PONA_FLOW_DISABLE_AUTH grants a local principal.
  root.render(
    <React.StrictMode>
      <AppShell />
    </React.StrictMode>
  );
} else {
  root.render(
    <React.StrictMode>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY!}>
        <Show
          when="signed-in"
          fallback={E2E_SKIP_AUTH_REDIRECT ? <E2EAuthShell /> : <RedirectToSignIn />}
        >
          <AuthenticatedApp />
        </Show>
      </ClerkProvider>
    </React.StrictMode>
  );
}
