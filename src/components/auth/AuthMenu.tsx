"use client";

import { useState } from "react";
import { signOut } from "@/lib/auth-client";

/**
 * AuthMenu — the header auth control (account-creation design.md § File Structure
 * "AuthMenu.tsx"; UI/UX Vision "Sign-in affordance" / "Signed-in state"; Phase 6
 * / p6).
 *
 * Two states, both rendered in the Pokédex-red header band (translucent-white
 * look, matching `ChampionsToggle`):
 *
 *   - Guest → a single non-blocking "Sign in" control (AC-1.2) that asks the
 *     parent to open `AuthDialog` via `onSignInClick`. It never gates the chat.
 *   - Signed in → the account email + a "Sign out" button (AUTH-US-5 / AC-5.1).
 *     Sign-out calls `signOut()` (current device only — AC-5.2) and then notifies
 *     the parent via `onSignedOut` so it reverts local state to the guest tier.
 *
 * Stateless w.r.t. auth identity: the parent owns `signedIn` / `email` (resolved
 * from `fetchMe`) and re-renders this control when they change. The only network
 * call here is `signOut`, routed through `@/lib/auth-client` — no direct `fetch`,
 * no server imports, so it is a pure jsdom-testable unit.
 */

export interface AuthMenuProps {
  /** Whether a user is currently signed in. */
  signedIn: boolean;
  /** The signed-in account's email (shown beside Sign out). */
  email?: string | null;
  /** Guest taps "Sign in" → parent opens the AuthDialog. */
  onSignInClick: () => void;
  /** Sign-out completed → parent flips local auth state back to guest. */
  onSignedOut: () => void;
}

export default function AuthMenu({
  signedIn,
  email,
  onSignInClick,
  onSignedOut,
}: AuthMenuProps) {
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
      // Notify the parent regardless of the network outcome: sign-out is
      // best-effort and the UI must revert to guest either way.
      onSignedOut();
    }
  }

  if (!signedIn) {
    return (
      <div className="auth-menu" data-testid="auth-menu">
        <button
          type="button"
          className="auth-pill"
          data-testid="auth-signin-button"
          onClick={onSignInClick}
        >
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="auth-menu" data-testid="auth-menu">
      {email && (
        <span
          className="auth-menu__email"
          data-testid="auth-user-email"
          title={email}
        >
          {email}
        </span>
      )}
      <button
        type="button"
        className="auth-pill"
        data-testid="auth-signout-button"
        onClick={handleSignOut}
        disabled={busy}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
