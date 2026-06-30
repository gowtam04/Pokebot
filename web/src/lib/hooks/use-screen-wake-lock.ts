/**
 * useScreenWakeLock — hold a Screen Wake Lock while `active` is true.
 *
 * WHY: the chat reads its answer from a long-lived `fetch` + SSE stream
 * (`useSseClient`). On a phone, a turn can run 60s+ (image turns especially);
 * with no interaction the screen auto-locks, the OS suspends the page, the
 * in-flight read freezes, and the connection dies — surfacing as a transport
 * "stream error". Keeping the screen awake for the duration prevents that
 * auto-lock, which is the dominant trigger of the mobile drop.
 *
 * The hook is best-effort and never throws:
 *   - no-ops where the API is absent (older engines, non-secure context),
 *   - only requests while the document is VISIBLE (the API rejects otherwise),
 *   - a wake lock auto-releases whenever the page is hidden, so it re-acquires
 *     on `visibilitychange` → visible while still `active`,
 *   - releases + drops the sentinel when `active` flips false or on unmount.
 *
 * Usage: `useScreenWakeLock(status === "thinking")` — active for exactly the
 * in-flight window (held across an automatic reconnect, since status stays
 * "thinking" throughout).
 */
"use client";

import { useEffect, useRef } from "react";

export function useScreenWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    if (typeof document === "undefined") return;

    // Tracks effect teardown so an in-flight `request()` that resolves AFTER
    // cleanup releases immediately instead of stranding a held lock.
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      if (cancelled) return;
      if (sentinelRef.current) return; // already held
      if (document.visibilityState !== "visible") return; // request() rejects when hidden
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
        // The OS may release the lock on its own (page hidden, low battery);
        // keep our ref in sync so a later re-acquire isn't short-circuited.
        sentinel.addEventListener("release", () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
        });
      } catch {
        /* best-effort: not visible / not allowed / low battery — ignore */
      }
    };

    const onVisibilityChange = (): void => {
      // Re-acquire on return to foreground (the lock auto-released on hide).
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, [active]);
}
