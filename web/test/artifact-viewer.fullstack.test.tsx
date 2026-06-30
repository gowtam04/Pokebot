/**
 * FULL-STACK (frontend) — the B-4 wire-up checkpoint (frontend-entity-e2e).
 * Renders a committed answer (AnswerCard) inside the ArtifactViewerProvider next
 * to the ArtifactViewer, with the entity-client mocked. Asserts the real wiring:
 * clicking a subject / citation / movepool move fetches `/api/entity` and the
 * panel renders the right profile; a citation parses to the right kind/slug; a
 * per-section button opens a structured artifact from the payload (no fetch);
 * drill-down + back navigate; "ask about this in chat" fires the page handler;
 * the external ↗ link survives; and the chat stays present with the panel open
 * (BR-AV-10).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, waitFor, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/lib/api/entity-client", () => ({ fetchEntityArtifact: vi.fn() }));

import { fetchEntityArtifact } from "@/lib/api/entity-client";
import type { EntityKind } from "@/agent/schemas";

import AnswerCard from "@/components/answer-card/AnswerCard";
import { CANONICAL_ANSWER } from "@/components/test-fixtures";
import { ArtifactViewerProvider } from "@/components/artifact/ArtifactViewerProvider";
import ArtifactViewer from "@/components/artifact/ArtifactViewer";
import {
  MOVE_ARTIFACT,
  POKEMON_ARTIFACT,
  TYPE_ARTIFACT,
} from "@/components/artifact/artifact-fixtures";

function byKind(kind: EntityKind) {
  switch (kind) {
    case "pokemon":
      return POKEMON_ARTIFACT;
    case "move":
      return MOVE_ARTIFACT;
    default:
      return TYPE_ARTIFACT;
  }
}

function renderChat(onAskInChat: (t: string) => void = vi.fn()) {
  return render(
    <ArtifactViewerProvider format="scarlet-violet" onAskInChat={onAskInChat}>
      <AnswerCard answer={CANONICAL_ANSWER} />
      <ArtifactViewer />
    </ArtifactViewerProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Artifact viewer wire-up", () => {
  it("clicking a subject sprite opens its Pokémon artifact; the chat stays visible", async () => {
    vi.mocked(fetchEntityArtifact).mockImplementation(async (kind) =>
      byKind(kind),
    );
    renderChat();

    await act(async () => {
      fireEvent.click(screen.getByTestId("sprite-card-link"));
    });

    expect(fetchEntityArtifact).toHaveBeenCalledWith(
      "pokemon",
      "Garchomp",
      "scarlet-violet",
    );
    expect(screen.getByTestId("pokemon-artifact")).toBeInTheDocument();
    // BR-AV-10: the conversation is still rendered alongside the open panel.
    expect(screen.getByTestId("answer-card")).toBeInTheDocument();
  });

  it("clicking a citation opens the parsed entity (move/earthquake)", async () => {
    vi.mocked(fetchEntityArtifact).mockImplementation(async (kind) =>
      byKind(kind),
    );
    renderChat();

    await act(async () => {
      // citations[1] = "move/earthquake" → parsed to kind=move, q=earthquake.
      fireEvent.click(screen.getByTestId("citation-entity-1"));
    });

    expect(fetchEntityArtifact).toHaveBeenCalledWith(
      "move",
      "earthquake",
      "scarlet-violet",
    );
    expect(screen.getByTestId("move-artifact")).toBeInTheDocument();
  });

  it("keeps the citation's external ↗ link alongside the clickable source", () => {
    renderChat();
    // CITATION_GARCHOMP carries an endpoint_url → the external link is retained.
    expect(screen.getByTestId("citation-link-0")).toBeInTheDocument();
    expect(screen.getByTestId("citation-entity-0")).toBeInTheDocument();
  });

  it("the per-section button opens the damage-calc artifact from payload (no fetch)", () => {
    renderChat();
    fireEvent.click(screen.getByTestId("open-damage-calc"));
    expect(screen.getByTestId("damage-calc-artifact")).toBeInTheDocument();
    expect(fetchEntityArtifact).not.toHaveBeenCalled();
  });

  it("drills from a Pokémon into a movepool move and back", async () => {
    vi.mocked(fetchEntityArtifact).mockImplementation(async (kind) =>
      byKind(kind),
    );
    renderChat();

    await act(async () => {
      fireEvent.click(screen.getByTestId("sprite-card-link"));
    });
    expect(screen.getByTestId("pokemon-artifact")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("movepool-move-dragon-claw"));
    });
    expect(screen.getByTestId("move-artifact")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-back")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("artifact-back"));
    await waitFor(() =>
      expect(screen.getByTestId("pokemon-artifact")).toBeInTheDocument(),
    );
  });

  it("ask-in-chat fires the page handler with a follow-up about the open artifact", async () => {
    const onAskInChat = vi.fn();
    vi.mocked(fetchEntityArtifact).mockImplementation(async (kind) =>
      byKind(kind),
    );
    renderChat(onAskInChat);

    await act(async () => {
      fireEvent.click(screen.getByTestId("sprite-card-link"));
    });
    fireEvent.click(screen.getByTestId("artifact-ask"));
    expect(onAskInChat).toHaveBeenCalledWith("Tell me more about Garchomp.");
  });
});
