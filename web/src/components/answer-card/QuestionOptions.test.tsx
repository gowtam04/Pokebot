import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import QuestionOptions from "./QuestionOptions";
import { QUESTION_ANSWER } from "@/components/test-fixtures";

const OPTIONS = QUESTION_ANSWER.question!.options;

describe("QuestionOptions", () => {
  it("renders nothing when options is empty", () => {
    const { container } = render(
      <QuestionOptions options={[]} onSelect={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one button per option", () => {
    render(<QuestionOptions options={OPTIONS} onSelect={vi.fn()} />);
    expect(screen.getByTestId("question-option-0")).toBeInTheDocument();
    expect(screen.getByTestId("question-option-1")).toBeInTheDocument();
  });

  it("renders the label and the description when present", () => {
    render(<QuestionOptions options={OPTIONS} onSelect={vi.fn()} />);
    expect(screen.getByText("Singles")).toBeInTheDocument();
    expect(
      screen.getByText("6v6, one Pokémon active per side"),
    ).toBeInTheDocument();
  });

  it("omits the description element when an option has none", () => {
    render(<QuestionOptions options={OPTIONS} onSelect={vi.fn()} />);
    // The second option ("Doubles") has no description.
    const second = screen.getByTestId("question-option-1");
    expect(second).toHaveTextContent("Doubles");
    expect(
      second.querySelector(".question-options__desc"),
    ).not.toBeInTheDocument();
  });

  it("calls onSelect with the clicked option's label verbatim (not the description)", () => {
    const onSelect = vi.fn();
    render(<QuestionOptions options={OPTIONS} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("question-option-0"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("Singles");
  });

  it("sends the correct label when the second option is clicked", () => {
    const onSelect = vi.fn();
    render(<QuestionOptions options={OPTIONS} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("question-option-1"));
    expect(onSelect).toHaveBeenCalledWith("Doubles");
  });

  it("renders options as <button> elements (keyboard-accessible)", () => {
    render(<QuestionOptions options={OPTIONS} onSelect={vi.fn()} />);
    expect(screen.getByTestId("question-option-0").tagName).toBe("BUTTON");
  });
});
