import { afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  within,
  act,
  fireEvent,
} from "@testing-library/react";

afterEach(() => cleanup());
import ChatThread from "./ChatThread";
import type { ChatThreadProps } from "@/components/types";
import { STARTER_PROMPTS } from "@/lib/example-prompts";
import { RESOLUTION_FAILED_ANSWER } from "@/components/test-fixtures";

/** Minimal props with sensible defaults; override per test. */
function props(overrides: Partial<ChatThreadProps> = {}): ChatThreadProps {
  return {
    turns: [],
    activity: [],
    status: "idle",
    streamingMarkdown: "",
    transportError: null,
    onFollowUp: () => {},
    ...overrides,
  };
}

describe("ChatThread — in-flight streaming bubble", () => {
  it("renders the streaming answer (as markdown) while streaming", () => {
    render(
      <ChatThread
        {...props({
          status: "streaming",
          streamingMarkdown: "Only **Ninetales** can learn both.",
        })}
      />,
    );
    const bubble = screen.getByTestId("streaming-answer");
    expect(bubble).toBeInTheDocument();
    // Markdown is rendered (bold → <strong>), not raw asterisks.
    expect(bubble.querySelector("strong")).toHaveTextContent("Ninetales");
    expect(within(bubble).queryByText(/\*\*/)).toBeNull();
  });

  it("does not render the streaming bubble when streamingMarkdown is empty", () => {
    render(<ChatThread {...props({ status: "streaming", streamingMarkdown: "" })} />);
    expect(screen.queryByTestId("streaming-answer")).not.toBeInTheDocument();
    // The thinking indicator still shows.
    expect(screen.getByTestId("progress-thinking")).toBeInTheDocument();
  });

  it("does not render the streaming bubble when idle", () => {
    render(
      <ChatThread
        {...props({ status: "idle", streamingMarkdown: "leftover text" })}
      />,
    );
    expect(screen.queryByTestId("streaming-answer")).not.toBeInTheDocument();
  });
});

describe("ChatThread — empty-state starter chips", () => {
  it("renders exactly 4 starter chips, each drawn from the prompt pool", () => {
    render(<ChatThread {...props({ turns: [], status: "idle" })} />);
    const chips = screen.getAllByTestId("chat-empty-example");
    // After mount the effect swaps the deterministic first-4 for a random 4.
    expect(chips).toHaveLength(4);
    for (const chip of chips) {
      expect(STARTER_PROMPTS).toContain(chip.textContent);
    }
    // No duplicates within the shown set (sampled without replacement).
    const shown = chips.map((c) => c.textContent);
    expect(new Set(shown).size).toBe(4);
  });

  it("shows no starter chips once the conversation has turns", () => {
    render(
      <ChatThread
        {...props({ turns: [{ id: "u1", role: "user", content: "hi" }] })}
      />,
    );
    expect(screen.queryByTestId("chat-empty")).toBeNull();
    expect(screen.queryByTestId("chat-empty-example")).toBeNull();
  });
});

describe("ChatThread — user-turn image thumbnails", () => {
  it("renders attached-image thumbnails from imagePreviews, keyed by turn id", () => {
    render(
      <ChatThread
        {...props({
          turns: [{ id: "u1", role: "user", content: "rate my team" }],
          imagePreviews: {
            u1: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
          },
        })}
      />,
    );
    const strip = screen.getByTestId("user-turn-images");
    const imgs = within(strip).getAllByRole("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute("src", "data:image/png;base64,AAA");
    // The text still renders alongside the thumbnails.
    expect(screen.getByText("rate my team")).toBeInTheDocument();
  });

  it("renders an image-only user turn (empty text) with no empty text bubble", () => {
    render(
      <ChatThread
        {...props({
          turns: [{ id: "u2", role: "user", content: "" }],
          imagePreviews: { u2: ["data:image/png;base64,CCC"] },
        })}
      />,
    );
    expect(screen.getByTestId("user-turn-images")).toBeInTheDocument();
    expect(
      screen.getByTestId("user-turn").querySelector(".chat-turn__content"),
    ).toBeNull();
  });

  it("renders no image strip for a text-only turn", () => {
    render(
      <ChatThread
        {...props({ turns: [{ id: "u3", role: "user", content: "hi" }] })}
      />,
    );
    expect(screen.queryByTestId("user-turn-images")).toBeNull();
  });
});

describe("ChatThread — answer-card follow-ups gated while streaming (U2)", () => {
  // A committed assistant turn with suggestion chips (the ungated U2 surface).
  const assistantTurn = {
    id: "a1",
    role: "assistant" as const,
    answer: RESOLUTION_FAILED_ANSWER,
  };
  const turns = [
    { id: "u1", role: "user" as const, content: "garcomp" },
    assistantTurn,
  ];

  it("disables committed answer-card follow-up chips while a new turn streams", () => {
    const onFollowUp = vi.fn();
    render(
      <ChatThread
        {...props({
          turns,
          status: "streaming",
          streamingMarkdown: "Working on it…",
          onFollowUp,
        })}
      />,
    );
    const chip = screen.getByTestId("suggestion-chip-0");
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    // A mid-stream chip click must NOT enqueue a follow-up (which would abort +
    // orphan the in-flight turn).
    expect(onFollowUp).not.toHaveBeenCalled();
  });

  it("keeps committed answer-card follow-up chips clickable when idle", () => {
    const onFollowUp = vi.fn();
    render(
      <ChatThread {...props({ turns, status: "idle", onFollowUp })} />,
    );
    const chip = screen.getByTestId("suggestion-chip-0");
    expect(chip).not.toBeDisabled();
    fireEvent.click(chip);
    expect(onFollowUp).toHaveBeenCalledWith("Garchomp");
  });
});

describe("ChatThread — in-flight current sub-task line", () => {
  it("shows the latest activity as the current line and earlier ones as a dim trail", () => {
    render(
      <ChatThread
        {...props({
          status: "streaming",
          activity: [
            { tool: "resolve_entity", label: "🔍 Resolving “garchom”…" },
            {
              tool: "query_pokedex",
              label: "📊 Searching the Pokédex: Fire · Speed > 100…",
            },
          ],
        })}
      />,
    );
    // The active line is the *latest* sub-task.
    expect(screen.getByTestId("progress-current")).toHaveTextContent(
      "Searching the Pokédex: Fire · Speed > 100",
    );
    // The earlier sub-task lingers as a (single) trail item.
    expect(screen.getByTestId("progress-item-0")).toHaveTextContent(
      "Resolving",
    );
    expect(screen.queryByTestId("progress-item-1")).toBeNull();
    // Not the generic thinking placeholder once a tool has run.
    expect(screen.queryByTestId("progress-thinking")).toBeNull();
  });

  it("labels the composing phase while answer prose streams", () => {
    render(
      <ChatThread
        {...props({
          status: "streaming",
          streamingMarkdown: "Only **Ninetales** can learn both.",
        })}
      />,
    );
    expect(screen.getByTestId("progress-current")).toHaveTextContent(
      "Writing the answer",
    );
  });

  it("labels the table-building phase when a markdown table starts streaming", () => {
    render(
      <ChatThread
        {...props({
          status: "streaming",
          streamingMarkdown:
            "Fastest Fire-types:\n\n| Name | Speed |\n| --- | --- |\n| Talonflame | 126 |",
        })}
      />,
    );
    expect(screen.getByTestId("progress-current")).toHaveTextContent(
      "Building the results table",
    );
  });

  it("falls back to a generic thinking line before the first tool runs", () => {
    render(<ChatThread {...props({ status: "streaming" })} />);
    expect(screen.getByTestId("progress-thinking")).toHaveTextContent(
      "Thinking through your question",
    );
  });

  it("reveals the elapsed-time counter only after a few seconds", () => {
    vi.useFakeTimers();
    try {
      render(<ChatThread {...props({ status: "streaming" })} />);
      // Hidden initially so a fast turn never flashes a "(0s)" badge.
      expect(screen.queryByTestId("progress-elapsed")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByTestId("progress-elapsed")).toHaveTextContent("(3s)");
    } finally {
      vi.useRealTimers();
    }
  });
});
