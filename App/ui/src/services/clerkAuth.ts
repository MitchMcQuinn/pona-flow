/**
 * Provider-agnostic `useAuth` / `useUser`.
 *
 * In Clerk mode these delegate to Clerk's hooks. In local (built-in) mode there is no
 * `ClerkProvider` in the tree, so they read the signed-in principal from
 * `LocalAuthContext` (provided by `main.tsx` once `/api/me` resolves). The mode is fixed
 * before the first render (see `authMode.ts`), so the branch is stable and does not
 * violate the rules of hooks.
 */
import { createContext, useContext } from "react";
import { useAuth as useClerkAuth, useUser as useClerkUser } from "@clerk/react";
import type { Me } from "../state/types";
import { authMode } from "./authMode";

export interface LocalAuthValue {
  me: Me | null;
  signOut: () => Promise<void>;
}

export const LocalAuthContext = createContext<LocalAuthValue>({
  me: null,
  signOut: async () => {}
});

export function useAuth(): ReturnType<typeof useClerkAuth> {
  if (authMode() === "local") {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const local = useContext(LocalAuthContext);
    return {
      isLoaded: true,
      isSignedIn: local.me !== null,
      userId: local.me?.principalId ?? null,
      getToken: async () => null,
      signOut: local.signOut
    } as unknown as ReturnType<typeof useClerkAuth>;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useClerkAuth();
}

export function useUser(): ReturnType<typeof useClerkUser> {
  if (authMode() === "local") {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const local = useContext(LocalAuthContext);
    const me = local.me;
    const name = me?.displayName ?? null;
    return {
      isLoaded: true,
      isSignedIn: me !== null,
      user: me
        ? {
            fullName: name,
            firstName: name ? name.split(" ")[0] : null,
            primaryEmailAddress: me.email ? { emailAddress: me.email } : null
          }
        : null
    } as unknown as ReturnType<typeof useClerkUser>;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useClerkUser();
}
