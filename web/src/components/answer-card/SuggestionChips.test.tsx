import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import SuggestionChips from "./SuggestionChips";
import {
  RESOLUTION_FAILED_ANSWER,
  CLARIFICATION_ANSWER,
} from "@/components/test-fixtures";

describe("SuggestionChips", () => {
  it("renders nothing when suggestions is empty", () => {
    const { container } = render(
      <SuggestionChips
        suggestions={[]}
        status="resolution_failed"
        onSelect={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one chip per suggestion", () => {
    const { suggestions } = RESOLUTION_FAILED_ANSWER;
    render(
      <SuggestionChips
        suggestions={suggestions!}
        status="resolution_failed"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("suggestion-chip-0")).toBeInTheDocument();
    expect(screen.getByTestId("suggestion-chip-1")).toBeInTheDocument();
  });

  it("renders chip text matching each suggestion", () => {
    const suggestions = ["Garchomp", "Gardevoir"];
    render(
      <SuggestionChips
        suggestions={suggestions}
        status="resolution_failed"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Garchomp")).toBeInTheDocument();
    expect(screen.getByText("Gardevoir")).toBeInTheDocument();
  });

  it("shows 'Did you mean:' label for resolution_failed", () => {
    render(
      <SuggestionChips
        suggestions={["Garchomp"]}
        status="resolution_failed"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("suggestion-chips-label")).toHaveTextContent(
      "Did you mean:",
    );
  });

  it("shows 'Suggestions:' label for clarification_needed", () => {
    const { suggestions } = CLARIFICATION_ANSWER;
    render(
      <SuggestionChips
        suggestions={suggestions!}
        status="clarification_needed"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("suggestion-chips-label")).toHaveTextContent(
      "Suggestions:",
    );
  });

  it("calls onSelect with the clicked suggestion text", () => {
    const onSelect = vi.fn();
    const suggestions = ["Garchomp", "Gardevoir"];
    render(
      <SuggestionChips
        suggestions={suggestions}
        status="resolution_failed"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("suggestion-chip-0"));
    expect(onSelect).toHaveBeenCalledWith("Garchomp");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("calls onSelect with the correct suggestion when the second chip is clicked", () => {
    const onSelect = vi.fn();
    const suggestions = ["Garchomp", "Gardevoir"];
    render(
      <SuggestionChips
        suggestions={suggestions}
        status="resolution_failed"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("suggestion-chip-1"));
    expect(onSelect).toHaveBeenCalledWith("Gardevoir");
  });

  it("renders chips as <button> elements (keyboard-accessible)", () => {
    render(
      <SuggestionChips
        suggestions={["Garchomp"]}
        status="resolution_failed"
        onSelect={vi.fn()}
      />,
    );
    const chip = screen.getByTestId("suggestion-chip-0");
    expect(chip.tagName).toBe("BUTTON");
  });

  it("renders all Tauros-form suggestions from clarification fixture", () => {
    const { suggestions } = CLARIFICATION_ANSWER;
    render(
      <SuggestionChips
        suggestions={suggestions!}
        status="clarification_needed"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Tauros (Paldean Combat)")).toBeInTheDocument();
    expect(screen.getByText("Tauros (Paldean Aqua)")).toBeInTheDocument();
    expect(screen.getByText("Tauros (Paldean Blaze)")).toBeInTheDocument();
  });
});
