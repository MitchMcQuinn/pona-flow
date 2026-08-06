/**
 * Thin wrappers over Clerk's `useAuth` / `useUser` hooks.
 *
 * When `AUTH_DISABLED` is set for local development there is no `ClerkProvider` in the
 * tree, so calling the real hooks would throw. These wrappers return inert stubs in that
 * mode instead. `AUTH_DISABLED` is a build/runtime constant that never changes during the
 * app's lifetime, so the branch is stable and does not violate the rules of hooks.
 */
import { useAuth as useClerkAuth, useUser as useClerkUser } from "@clerk/react";
import { AUTH_DISABLED } from "./authMode";

export function useAuth(): ReturnType<typeof useClerkAuth> {
  if (AUTH_DISABLED) {
    return {
      isLoaded: true,
      isSignedIn: true,
      userId: "dev-local-user",
      getToken: async () => null,
      signOut: async () => {},
    } as unknown as ReturnType<typeof useClerkAuth>;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useClerkAuth();
}

export function useUser(): ReturnType<typeof useClerkUser> {
  if (AUTH_DISABLED) {
    return {
      isLoaded: true,
      isSignedIn: true,
      user: {
        fullName: "Local Dev",
        firstName: "Local",
        primaryEmailAddress: { emailAddress: "dev@localhost" },
      },
    } as unknown as ReturnType<typeof useClerkUser>;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useClerkUser();
}
