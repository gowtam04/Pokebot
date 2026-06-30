/**
 * Unit tests for `useScreenWakeLock` (src/lib/hooks/use-screen-wake-lock.ts).
 *
 * Runs in the jsdom project (`test/**\/*.test.tsx`) — no Docker. `navigator.wakeLock`
 * is absent in jsdom, so we install a configurable mock and drive the Page
 * Visibility getters (`document.hidden` / `visibilityState` are prototype
 * getters, shadowed with own-props we can flip).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useScreenWakeLock } from "@/lib/hooks/use-screen-wake-lock";

// --- Fake WakeLockSentinel ------------------------------------------------

interface FakeSentinel {
  release: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  /** Invoke the captured "release" listener (simulates an OS-initiated release). */
  triggerRelease: () => void;
}

function fakeSentinel(): FakeSentinel {
  let releaseCb: (() => void) | null = null;
  return {
    release: vi.fn(async () => {}),
    addEventListener: vi.fn((type: string, cb: () => void) => {
      if (type === "release") releaseCb = cb;
    }),
    triggerRelease: () => releaseCb?.(),
  };
}

function installWakeLock(
  request: (type: string) => Promise<unknown>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(request);
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: mock },
  });
  return mock;
}
function removeWakeLock(): void {
  Reflect.deleteProperty(navigator, "wakeLock");
}

// --- Page-visibility control ----------------------------------------------

let docHidden = false;
function installVisibility(): void {
  docHidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => docHidden,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (docHidden ? "hidden" : "visible"),
  });
}
function restoreVisibility(): void {
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(document, "visibilityState");
  docHidden = false;
}
function setHidden(hidden: boolean): void {
  docHidden = hidden;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => installVisibility());
afterEach(() => {
  removeWakeLock();
  restoreVisibility();
  vi.restoreAllMocks();
});

describe("useScreenWakeLock", () => {
  it("acquires a screen wake lock while active and visible", async () => {
    const request = installWakeLock(async () => fakeSentinel());

    renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: true },
    });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("screen");
  });

  it("does not acquire while inactive", async () => {
    const request = installWakeLock(async () => fakeSentinel());

    renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: false },
    });

    await act(async () => {});
    expect(request).not.toHaveBeenCalled();
  });

  it("releases the lock when active flips false", async () => {
    const sentinel = fakeSentinel();
    const request = installWakeLock(async () => sentinel);

    const { rerender } = renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    rerender({ active: false });
    await waitFor(() => expect(sentinel.release).toHaveBeenCalled());
  });

  it("re-acquires on return to foreground after an OS auto-release", async () => {
    const sentinel = fakeSentinel();
    const request = installWakeLock(async () => sentinel);

    renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sentinel.addEventListener).toHaveBeenCalled());

    // The OS auto-releases the lock when the page hides.
    act(() => {
      setHidden(true);
      sentinel.triggerRelease();
    });
    // Back to foreground → re-acquire.
    act(() => setHidden(false));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it("no-ops (no throw) when the Wake Lock API is unavailable", async () => {
    removeWakeLock();
    expect(() =>
      renderHook(({ active }) => useScreenWakeLock(active), {
        initialProps: { active: true },
      }),
    ).not.toThrow();
    await act(async () => {});
  });

  it("swallows a rejected request() (best-effort, no throw)", async () => {
    const request = installWakeLock(async () => {
      throw new Error("denied (low battery)");
    });

    expect(() =>
      renderHook(({ active }) => useScreenWakeLock(active), {
        initialProps: { active: true },
      }),
    ).not.toThrow();
    await waitFor(() => expect(request).toHaveBeenCalled());
    await act(async () => {});
  });

  it("releases the lock on unmount", async () => {
    const sentinel = fakeSentinel();
    const request = installWakeLock(async () => sentinel);

    const { unmount } = renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sentinel.addEventListener).toHaveBeenCalled());

    unmount();
    await waitFor(() => expect(sentinel.release).toHaveBeenCalled());
  });
});
