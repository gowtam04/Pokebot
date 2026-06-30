/**
 * FULL-STACK-E2E CHECKPOINT (frontend half) — renders EACH canonical
 * `OakAnswer` payload from output-formats.md through the top-level
 * <AnswerCard/> and asserts the mapped leaf components appear (the consumer
 * contract in output-formats.md / ux-design.md).
 *
 * This mirrors the backend checkpoint (test/api-chat.integration.test.ts): there
 * the route's SSE framing is proven; here the AnswerCard field→component mapping
 * is proven. It imports ONLY view code + plain fixture objects — never
 * db/repos/runtime (those open a Postgres connection / pull server-only).
 *
 * Runs in the Vitest "jsdom" project (jest-dom matchers from its setupFiles).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  cleanup,
} from "@testing-library/react";

import AnswerCard from "@/components/answer-card/AnswerCard";
import {
  CANONICAL_ANSWER,
  MINIMAL_ANSWER,
  RESOLUTION_FAILED_ANSWER,
  FALLBACK_ANSWER,
  CLARIFICATION_ANSWER,
  QUESTION_ANSWER,
} from "@/components/test-fixtures";

// Spy on the artifact viewer: a candidate row / subject sprite opens that
// Pokémon's artifact (no real provider is mounted here, so stub the hook).
const { openEntity } = vi.hoisted(() => ({ openEntity: vi.fn() }));
vi.mock("@/components/artifact/useArtifactViewer", () => ({
  useArtifactViewer: () => ({
    isOpen: false,
    current: null,
    canGoBack: false,
    openEntity,
    openStructured: () => {},
    openTeam: () => {},
    back: () => {},
    close: () => {},
    askInChat: () => {},
  }),
}));

afterEach(() => {
  cleanup();
  openEntity.mockClear();
});

// ---------------------------------------------------------------------------
// Canonical "answered" payload — every optional field populated.
// ---------------------------------------------------------------------------

describe("AnswerCard — canonical answered payload (all fields)", () => {
  it("always renders the AnswerBody (answer_markdown)", () => {
    render(<AnswerCard answer={CANONICAL_ANSWER} />);
    const body = screen.getByTestId("answer-body");
    expect(body).toBeInTheDocument();
    expect(body).toHaveTextContent("base Speed stat of 102");
  });

  it("renders a subject SpriteCard with sprite + name + type badges", () => {
    render(<AnswerCard answer={CANONICAL_ANSWER} />);
    const sprite = screen.getByTestId("sprite-card");
    expect(sprite).toBeInTheDocument();
    // Sprite image with the subject name as alt text.
    expect(
      within(sprite).getByRole("img", { name: "Garchomp" }),
    ).toHaveAttribute("src", CANONICAL_ANSWER.subjects![0]!.sprite_url);
    // A TypeBadge per type (scoped to the sprite card — the candidate table also
    // renders a Garchomp row with the same type badges).
    expect(within(sprite).getByTestId("type-badge-dragon")).toBeInTheDocument();
    expect(within(sprite).getByTestId("type-badge-ground")).toBeInTheDocument();
  });

  it('renders the CandidateTable with an honest "N of M" count when truncated', () => {
    render(<AnswerCard answer={CANONICAL_ANSWER} />);
    expect(screen.getByTestId("candidate-table")).toBeInTheDocument();
    // CANDIDATES_TRUNCATED: shown 2 of total 50.
    expect(screen.getByTestId("candidate-table-count")).toHaveTextContent(
      "Showing 2 of 50",
    );
  });

  it("renders the citations through a SourceList", () => {
    render(<AnswerCard answer={CANONICAL_ANSWER} />);
    const sources = screen.getByTestId("source-list");
    expect(sources).toBeInTheDocument();
    // Two citations in the canonical payload.
    expect(screen.getByTestId("source-list-summary")).toHaveTextContent(
      "Sources (2)",
    );
    expect(screen.getByTestId("citation-0")).toHaveTextContent(
      "pokemon/garchomp",
    );
  });

  it("renders an InferenceCallout for the deduction", () => {
    render(<AnswerCard answer={CANONICAL_ANSWER} />);
    expect(screen.getByTestId("inference-callout")).toBeInTheDocument();
    expect(screen.getByTestId("inference-item-0")).toHaveTextContent(
      "outspeeds most Ground-type threats",
    );
  });

  it("renders a CaveatStrip for the uncertainty_flags", () => {
    render(<AnswerCard answer={CANONICAL_ANSWER} />);
    const strip = screen.getByTestId("caveat-strip");
    expect(strip).toBeInTheDocument();
    expect(screen.getByTestId("caveat-flag-0")).toHaveTextContent(
      "Result assumes the standard Rough Skin ability",
    );
  });

  it("renders the DamageReadout with its estimate tag and computed result", () => {
    render(<AnswerCard answer={CANONICAL_ANSWER} />);
    expect(screen.getByTestId("damage-readout")).toBeInTheDocument();
    expect(screen.getByTestId("damage-estimate-tag")).toHaveTextContent(
      "Estimate",
    );
    const result = screen.getByTestId("damage-result");
    expect(result).toHaveTextContent("min_damage");
    expect(result).toHaveTextContent("142");
    expect(result).toHaveTextContent("168");
  });

  it("renders the ReasoningBlock (the collapsible 'why')", () => {
    render(<AnswerCard answer={CANONICAL_ANSWER} />);
    expect(screen.getByTestId("reasoning-block")).toBeInTheDocument();
    expect(screen.getByTestId("reasoning-block-content")).toHaveTextContent(
      "query_pokedex",
    );
  });

  it("tags the card with the answer status", () => {
    render(<AnswerCard answer={CANONICAL_ANSWER} />);
    expect(screen.getByTestId("answer-card")).toHaveAttribute(
      "data-status",
      "answered",
    );
  });
});

// ---------------------------------------------------------------------------
// Minimal "answered" payload — only required fields. Optional leaves absent.
// ---------------------------------------------------------------------------

describe("AnswerCard — minimal answered payload (no optional fields)", () => {
  it("renders the answer body and sources but omits the optional leaves", () => {
    render(<AnswerCard answer={MINIMAL_ANSWER} />);
    expect(screen.getByTestId("answer-body")).toBeInTheDocument();
    expect(screen.getByTestId("source-list")).toBeInTheDocument();
    // No subjects / candidates / damage / inferences / suggestions / caveats.
    expect(screen.queryByTestId("sprite-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("candidate-table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("damage-readout")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inference-callout")).not.toBeInTheDocument();
    expect(screen.queryByTestId("suggestion-chips")).not.toBeInTheDocument();
    expect(screen.queryByTestId("question-options")).not.toBeInTheDocument();
    expect(screen.queryByTestId("caveat-strip")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// question.options → QuestionOptions (the "stop and ask" affordance).
// ---------------------------------------------------------------------------

describe("AnswerCard — question options & follow-up wiring", () => {
  it("renders QuestionOptions when the answer carries question.options", () => {
    render(<AnswerCard answer={QUESTION_ANSWER} />);
    const options = screen.getByTestId("question-options");
    expect(options).toBeInTheDocument();
    expect(within(options).getByText("Singles")).toBeInTheDocument();
    expect(within(options).getByText("Doubles")).toBeInTheDocument();
    // The question prose still renders through the AnswerBody.
    expect(screen.getByTestId("answer-body")).toHaveTextContent(
      "Singles or Doubles",
    );
  });

  it("fires onFollowUp with the option label verbatim when clicked", () => {
    const onFollowUp = vi.fn();
    render(<AnswerCard answer={QUESTION_ANSWER} onFollowUp={onFollowUp} />);
    fireEvent.click(screen.getByTestId("question-option-0"));
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onFollowUp).toHaveBeenCalledWith("Singles");
  });

  it("does not render QuestionOptions for a plain suggestion-only clarification", () => {
    render(<AnswerCard answer={CLARIFICATION_ANSWER} />);
    expect(screen.queryByTestId("question-options")).not.toBeInTheDocument();
    expect(screen.getByTestId("suggestion-chips")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// generation_basis.fallback → CaveatStrip + fallback sprite badge.
// ---------------------------------------------------------------------------

describe("AnswerCard — generation fallback payload", () => {
  it("renders the caveat strip's fallback note and a fallback-flagged sprite", () => {
    render(<AnswerCard answer={FALLBACK_ANSWER} />);
    expect(screen.getByTestId("caveat-strip")).toBeInTheDocument();
    expect(screen.getByTestId("caveat-fallback")).toHaveTextContent(
      "Mewtwo is not available in Gen 9",
    );
    // The fallback subject is flagged on its sprite card.
    expect(screen.getByTestId("sprite-card-fallback")).toHaveTextContent(
      "gen-1",
    );
  });
});

// ---------------------------------------------------------------------------
// Clarification / resolution_failed → SuggestionChips + follow-up wiring.
// ---------------------------------------------------------------------------

describe("AnswerCard — suggestion chips & follow-up wiring", () => {
  it('renders "Did you mean" chips for resolution_failed and fires onFollowUp on click', () => {
    const onFollowUp = vi.fn();
    render(
      <AnswerCard answer={RESOLUTION_FAILED_ANSWER} onFollowUp={onFollowUp} />,
    );
    const chips = screen.getByTestId("suggestion-chips");
    expect(chips).toBeInTheDocument();
    expect(screen.getByTestId("suggestion-chips-label")).toHaveTextContent(
      "Did you mean:",
    );

    fireEvent.click(screen.getByTestId("suggestion-chip-0"));
    // The chosen name is sent verbatim as the follow-up message.
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onFollowUp).toHaveBeenCalledWith(
      RESOLUTION_FAILED_ANSWER.suggestions![0],
    );
  });

  it("renders disambiguation chips for clarification_needed", () => {
    render(<AnswerCard answer={CLARIFICATION_ANSWER} />);
    expect(screen.getByTestId("suggestion-chips")).toBeInTheDocument();
    expect(screen.getByTestId("suggestion-chip-2")).toHaveTextContent(
      "Tauros (Paldean Blaze)",
    );
    // No citations were used for a clarification — Sources list is empty (0).
    expect(screen.getByTestId("source-list-summary")).toHaveTextContent(
      "Sources (0)",
    );
  });

  it("opens the Pokémon's artifact (not a chat follow-up) when a candidate row is clicked", () => {
    const onFollowUp = vi.fn();
    render(<AnswerCard answer={CANONICAL_ANSWER} onFollowUp={onFollowUp} />);
    fireEvent.click(screen.getByTestId("candidate-row-0"));
    expect(openEntity).toHaveBeenCalledWith({ kind: "pokemon", q: "Garchomp" });
    expect(onFollowUp).not.toHaveBeenCalled();
  });
});
