/**
 * B-4 Phase 5 — panel shell. Renders ArtifactViewer inside the provider and
 * drives the captured API: hidden when closed; loading → ok (dispatches to the
 * right renderer + grounding chrome); not_found / unavailable / error states;
 * structured (payload-derived) dispatch; back + close controls; Esc closes.
 * The entity-client is mocked so there is no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, waitFor, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/lib/api/entity-client", () => ({ fetchEntityArtifact: vi.fn() }));

import { fetchEntityArtifact } from "@/lib/api/entity-client";
import { DAMAGE_CALC_GARCHOMP } from "@/components/test-fixtures";

import { ArtifactViewerProvider } from "./ArtifactViewerProvider";
import ArtifactViewer from "./ArtifactViewer";
import { useArtifactViewer } from "./useArtifactViewer";
import type { ArtifactViewerApi } from "./types";
import {
  MOVE_ARTIFACT,
  NOT_FOUND_ARTIFACT,
  POKEMON_ARTIFACT,
  UNAVAILABLE_ARTIFACT,
} from "./artifact-fixtures";

let api: ArtifactViewerApi;
function Capture() {
  api = useArtifactViewer();
  return null;
}

function mount(onAskInChat?: (t: string) => void) {
  return render(
    <ArtifactViewerProvider format="scarlet-violet" onAskInChat={onAskInChat}>
      <Capture />
      <ArtifactViewer />
    </ArtifactViewerProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ArtifactViewer — visibility + ok dispatch", () => {
  it("renders nothing until something is open", () => {
    mount();
    expect(screen.queryByTestId("artifact-viewer")).toBeNull();
  });

  it("shows loading, then dispatches an ok pokemon to PokemonArtifact with grounding", async () => {
    let resolveFetch: (r: typeof POKEMON_ARTIFACT) => void = () => {};
    vi.mocked(fetchEntityArtifact).mockReturnValue(
      new Promise((r) => {
        resolveFetch = r;
      }),
    );
    mount();

    act(() => api.openEntity({ kind: "pokemon", q: "garchomp" }));
    expect(screen.getByTestId("artifact-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-loading")).toBeInTheDocument();

    await act(async () => {
      resolveFetch(POKEMON_ARTIFACT);
    });
    expect(screen.getByTestId("pokemon-artifact")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-title")).toHaveTextContent("Garchomp");
    expect(screen.getByTestId("artifact-format-tag")).toHaveTextContent(
      "Scarlet/Violet",
    );
    // Grounding footer (citations) is present.
    expect(screen.getByTestId("artifact-sources")).toBeInTheDocument();
  });
});

describe("ArtifactViewer — honest states", () => {
  it("renders the not_found state with suggestions", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(NOT_FOUND_ARTIFACT);
    mount();
    act(() => api.openEntity({ kind: "pokemon", q: "garchom" }));
    await waitFor(() =>
      expect(screen.getByTestId("artifact-not-found")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("artifact-not-found")).toHaveTextContent(
      "Garchomp",
    );
  });

  it("renders the unavailable state", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(UNAVAILABLE_ARTIFACT);
    mount();
    act(() => api.openEntity({ kind: "pokemon", q: "garchomp" }));
    await waitFor(() =>
      expect(screen.getByTestId("artifact-unavailable")).toBeInTheDocument(),
    );
  });

  it("renders the error state on a transport fault", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(null);
    mount();
    act(() => api.openEntity({ kind: "move", q: "earthquake" }));
    await waitFor(() =>
      expect(screen.getByTestId("artifact-error")).toBeInTheDocument(),
    );
  });
});

describe("ArtifactViewer — structured + controls", () => {
  it("dispatches a structured damage-calc from payload (no fetch)", () => {
    mount();
    act(() =>
      api.openStructured({
        kind: "damage-calc",
        damageCalc: DAMAGE_CALC_GARCHOMP,
      }),
    );
    expect(fetchEntityArtifact).not.toHaveBeenCalled();
    expect(screen.getByTestId("damage-calc-artifact")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-title")).toHaveTextContent(
      "Damage calculation",
    );
  });

  it("shows back only after a drill-down, and back returns to the prior artifact", async () => {
    vi.mocked(fetchEntityArtifact).mockResolvedValue(MOVE_ARTIFACT);
    mount();

    await act(async () => {
      api.openEntity({ kind: "move", q: "earthquake" });
    });
    expect(screen.queryByTestId("artifact-back")).toBeNull();

    vi.mocked(fetchEntityArtifact).mockResolvedValue(POKEMON_ARTIFACT);
    await act(async () => {
      api.openEntity({ kind: "pokemon", q: "garchomp" });
    });
    expect(screen.getByTestId("artifact-back")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-title")).toHaveTextContent("Garchomp");

    fireEvent.click(screen.getByTestId("artifact-back"));
    await waitFor(() =>
      expect(screen.getByTestId("artifact-title")).toHaveTextContent(
        "Earthquake",
      ),
    );
  });

  it("close dismisses the viewer; Esc also closes; ask-in-chat fires the handler", async () => {
    const onAskInChat = vi.fn();
    vi.mocked(fetchEntityArtifact).mockResolvedValue(POKEMON_ARTIFACT);
    mount(onAskInChat);

    await act(async () => {
      api.openEntity({ kind: "pokemon", q: "garchomp" });
    });
    fireEvent.click(screen.getByTestId("artifact-ask"));
    expect(onAskInChat).toHaveBeenCalledWith("Tell me more about Garchomp.");

    fireEvent.click(screen.getByTestId("artifact-close"));
    expect(screen.queryByTestId("artifact-viewer")).toBeNull();

    // Re-open then close via Escape.
    await act(async () => {
      api.openEntity({ kind: "pokemon", q: "garchomp" });
    });
    expect(screen.getByTestId("artifact-viewer")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("artifact-viewer")).toBeNull();
  });
});
