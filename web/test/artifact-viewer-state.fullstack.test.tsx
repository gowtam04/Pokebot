/**
 * Tests for the artifact-viewer state machine (B-4 Phase 4): ArtifactViewerProvider
 * + useArtifactViewer. The entity-client is mocked so open → loading → done/error,
 * the not_found/unavailable envelopes, drill-down + back, one-at-a-time replace,
 * close, the per-session cache, and the format snapshot are asserted without any
 * network. Runs under the jsdom project (no Docker).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/lib/api/entity-client", () => ({ fetchEntityArtifact: vi.fn() }));

import { fetchEntityArtifact } from "@/lib/api/entity-client";
import type { EntityArtifactResponse } from "@/lib/entity-artifact";
import {
  DAMAGE_CALC_GARCHOMP,
  SUBJECT_GARCHOMP,
} from "@/components/test-fixtures";

import { ArtifactViewerProvider } from "@/components/artifact/ArtifactViewerProvider";
import { useArtifactViewer } from "@/components/artifact/useArtifactViewer";
import type { ArtifactFormat } from "@/components/artifact/types";

const OK_MOVE: EntityArtifactResponse = {
  status: "ok",
  kind: "move",
  format: "scarlet-violet",
  resolved: { slug: "earthquake", display_name: "Earthquake" },
  generation: "Scarlet/Violet (Gen 9)",
  is_fallback: false,
  citations: [{ source: "move/earthquake", detail: "Power, accuracy, PP." }],
  data: {
    display_name: "Earthquake",
    type: "ground",
    damage_class: "physical",
    power: 100,
    accuracy: 100,
    pp: 10,
    priority: 0,
    target: "all-other-pokemon",
    effect_short: "Hits all adjacent.",
    effect_full: "Hits all adjacent Pokémon.",
  },
};

const NOT_FOUND: EntityArtifactResponse = {
  status: "not_found",
  kind: "pokemon",
  format: "scarlet-violet",
  query: "zzz",
  suggestions: [],
};

const UNAVAILABLE: EntityArtifactResponse = {
  status: "unavailable",
  kind: "pokemon",
  format: "scarlet-violet",
};

function wrapperWith(
  format: ArtifactFormat,
  onAskInChat?: (text: string) => void,
) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <ArtifactViewerProvider format={format} onAskInChat={onAskInChat}>
      {children}
    </ArtifactViewerProvider>
  );
  Wrapper.displayName = "ArtifactViewerTestWrapper";
  return Wrapper;
}

function renderViewer(
  format: ArtifactFormat = "scarlet-violet",
  onAskInChat?: (text: string) => void,
) {
  return renderHook(() => useArtifactViewer(), {
    wrapper: wrapperWith(format, onAskInChat),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ArtifactViewerProvider — entity open lifecycle", () => {
  it("starts closed", () => {
    const { result } = renderViewer();
    expect(result.current.isOpen).toBe(false);
    expect(result.current.current).toBeNull();
    expect(result.current.canGoBack).toBe(false);
  });

  it("transitions loading → done with the ok envelope", async () => {
    let resolveFetch: (r: EntityArtifactResponse | null) => void = () => {};
    vi.mocked(fetchEntityArtifact).mockReturnValue(
      new Promise((r) => {
        resolveFetch = r;
      }),
    );
    const { result } = renderViewer();

    act(() => result.current.openEntity({ kind: "move", q: "earthquake" }));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.current?.type).toBe("entity");
    if (result.current.current?.type !== "entity") throw new Error("entity");
    expect(result.current.current.phase).toBe("loading");

    await act(async () => {
      resolveFetch(OK_MOVE);
    });
    if (result.current.current?.type !== "entity") throw new Error("entity");
    expect(result.current.current.phase).toBe("done");
    expect(result.current.current.response).toEqual(OK_MOVE);
  });

  it("carries the not_found envelope as a done view", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(NOT_FOUND);
    const { result } = renderViewer();
    act(() => result.current.openEntity({ kind: "pokemon", q: "zzz" }));
    await waitFor(() => {
      if (result.current.current?.type !== "entity") throw new Error("entity");
      expect(result.current.current.phase).toBe("done");
    });
    if (result.current.current?.type !== "entity") throw new Error("entity");
    expect(result.current.current.response?.status).toBe("not_found");
  });

  it("carries the unavailable envelope as a done view", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(UNAVAILABLE);
    const { result } = renderViewer();
    act(() => result.current.openEntity({ kind: "pokemon", q: "garchomp" }));
    await waitFor(() => {
      if (result.current.current?.type !== "entity") throw new Error("entity");
      expect(result.current.current.response?.status).toBe("unavailable");
    });
  });

  it("marks the view errored on a transport fault (null)", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(null);
    const { result } = renderViewer();
    act(() => result.current.openEntity({ kind: "move", q: "earthquake" }));
    await waitFor(() => {
      if (result.current.current?.type !== "entity") throw new Error("entity");
      expect(result.current.current.phase).toBe("error");
    });
  });
});

describe("ArtifactViewerProvider — stack navigation", () => {
  it("pushes on every open (drill-down) and pops on back; close clears", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(OK_MOVE);
    const { result } = renderViewer();

    await act(async () => {
      result.current.openEntity({ kind: "move", q: "earthquake" });
    });
    await act(async () => {
      result.current.openEntity({ kind: "pokemon", q: "garchomp" });
    });
    // Only the top is shown, and back is now possible.
    expect(result.current.canGoBack).toBe(true);
    if (result.current.current?.type !== "entity") throw new Error("entity");
    expect(result.current.current.request.q).toBe("garchomp");

    act(() => result.current.back());
    if (result.current.current?.type !== "entity") throw new Error("entity");
    expect(result.current.current.request.q).toBe("earthquake");
    expect(result.current.canGoBack).toBe(false);

    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.current).toBeNull();
  });
});

describe("ArtifactViewerProvider — structured opens + cache + format + askInChat", () => {
  it("opens a structured artifact from payload without fetching", () => {
    const { result } = renderViewer();
    act(() =>
      result.current.openStructured({
        kind: "damage-calc",
        damageCalc: DAMAGE_CALC_GARCHOMP,
      }),
    );
    expect(fetchEntityArtifact).not.toHaveBeenCalled();
    if (result.current.current?.type !== "structured") {
      throw new Error("structured");
    }
    expect(result.current.current.artifact.kind).toBe("damage-calc");
    expect(result.current.current.artifact.format).toBe("scarlet-violet");
  });

  it("opens a comparison artifact carrying the subjects payload", () => {
    const { result } = renderViewer();
    act(() =>
      result.current.openStructured({
        kind: "comparison",
        subjects: [SUBJECT_GARCHOMP],
      }),
    );
    if (
      result.current.current?.type !== "structured" ||
      result.current.current.artifact.kind !== "comparison"
    ) {
      throw new Error("comparison");
    }
    expect(result.current.current.artifact.subjects).toHaveLength(1);
  });

  it("snapshots the provider's format onto the entity request + fetch", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(OK_MOVE);
    const { result } = renderViewer("champions");
    await act(async () => {
      result.current.openEntity({ kind: "move", q: "earthquake" });
    });
    if (result.current.current?.type !== "entity") throw new Error("entity");
    expect(result.current.current.request.format).toBe("champions");
    expect(fetchEntityArtifact).toHaveBeenCalledWith(
      "move",
      "earthquake",
      "champions",
    );
  });

  it("serves a re-opened entity from cache (one fetch)", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(OK_MOVE);
    const { result } = renderViewer();

    await act(async () => {
      result.current.openEntity({ kind: "move", q: "Earthquake" });
    });
    act(() => result.current.close());
    // Re-open the same (case-insensitive) entity.
    act(() => result.current.openEntity({ kind: "move", q: "earthquake" }));

    expect(fetchEntityArtifact).toHaveBeenCalledTimes(1);
    if (result.current.current?.type !== "entity") throw new Error("entity");
    expect(result.current.current.phase).toBe("done");
    expect(result.current.current.response).toEqual(OK_MOVE);
  });

  it("delegates askInChat to the provider's onAskInChat handler", () => {
    const onAskInChat = vi.fn();
    const { result } = renderViewer("scarlet-violet", onAskInChat);
    act(() => result.current.askInChat("Tell me more about Garchomp"));
    expect(onAskInChat).toHaveBeenCalledWith("Tell me more about Garchomp");
  });
});
