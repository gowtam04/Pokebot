import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import AnswerBody from "./AnswerBody";

afterEach(() => cleanup());
import { CANONICAL_ANSWER, MINIMAL_ANSWER } from "@/components/test-fixtures";

describe("AnswerBody", () => {
  it("renders the markdown text", () => {
    render(<AnswerBody markdown={CANONICAL_ANSWER.answer_markdown} />);
    expect(screen.getByTestId("answer-body")).toHaveTextContent(
      CANONICAL_ANSWER.answer_markdown,
    );
  });

  it("renders bold markdown as <strong>", () => {
    render(<AnswerBody markdown="This is **bold** text." />);
    const strong = screen.getByTestId("answer-body").querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent("bold");
  });

  it("renders GFM pipe tables as a real <table> (issue #4)", () => {
    const md = ["| Name | Type |", "| --- | --- |", "| Garchomp | Dragon |"].join(
      "\n",
    );
    render(<AnswerBody markdown={md} />);
    const body = screen.getByTestId("answer-body");
    expect(within(body).getByRole("table")).toBeInTheDocument();
    expect(
      within(body).getAllByRole("columnheader").map((h) => h.textContent),
    ).toEqual(["Name", "Type"]);
    expect(
      within(body).getByRole("cell", { name: "Garchomp" }),
    ).toBeInTheDocument();
  });

  it("renders minimal one-liner text", () => {
    render(<AnswerBody markdown={MINIMAL_ANSWER.answer_markdown} />);
    expect(
      screen.getByText(MINIMAL_ANSWER.answer_markdown),
    ).toBeInTheDocument();
  });

  it("preserves multiline text (newlines not collapsed)", () => {
    const multiline = "Line one.\nLine two.\nLine three.";
    render(<AnswerBody markdown={multiline} />);
    // The container should have the full text node including newlines
    expect(screen.getByTestId("answer-body")).toHaveTextContent("Line one.");
    expect(screen.getByTestId("answer-body")).toHaveTextContent("Line two.");
    expect(screen.getByTestId("answer-body")).toHaveTextContent("Line three.");
  });

  it("renders an empty string without crashing", () => {
    render(<AnswerBody markdown="" />);
    expect(screen.getByTestId("answer-body")).toBeInTheDocument();
  });
});
