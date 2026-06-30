import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import ReasoningBlock from "./ReasoningBlock";
import { CANONICAL_ANSWER } from "@/components/test-fixtures";

describe("ReasoningBlock", () => {
  const markdown = CANONICAL_ANSWER.reasoning_markdown;

  it("renders a disclosure element with 'Reasoning' summary", () => {
    render(<ReasoningBlock markdown={markdown} />);
    const details = screen.getByTestId("reasoning-block");
    expect(details.tagName).toBe("DETAILS");
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
  });

  it("is collapsed by default (open attribute absent)", () => {
    render(<ReasoningBlock markdown={markdown} />);
    const details = screen.getByTestId("reasoning-block") as HTMLDetailsElement;
    // When open is not set, the details element is closed
    expect(details.open).toBe(false);
  });

  it("renders expanded when defaultExpanded=true", () => {
    render(<ReasoningBlock markdown={markdown} defaultExpanded />);
    const details = screen.getByTestId("reasoning-block") as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it("renders the markdown content", () => {
    render(<ReasoningBlock markdown={markdown} defaultExpanded />);
    expect(screen.getByTestId("reasoning-block-content")).toHaveTextContent(
      "query_pokedex",
    );
  });

  it("renders markdown formatting (bold) inside the content", () => {
    render(
      <ReasoningBlock markdown="Because **Armor Tail** blocks it." defaultExpanded />,
    );
    const strong = screen
      .getByTestId("reasoning-block-content")
      .querySelector("strong");
    expect(strong).toHaveTextContent("Armor Tail");
  });

  it("renders without crashing for minimal markdown", () => {
    render(<ReasoningBlock markdown="Simple reasoning." />);
    expect(screen.getByTestId("reasoning-block")).toBeInTheDocument();
  });
});
