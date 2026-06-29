import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import SourceList from "./SourceList";
import {
  CITATION_GARCHOMP,
  CITATION_EARTHQUAKE,
  CANONICAL_ANSWER,
} from "@/components/test-fixtures";

describe("SourceList", () => {
  const citations = CANONICAL_ANSWER.citations;

  it("renders a collapsible disclosure element", () => {
    render(<SourceList citations={citations} />);
    const details = screen.getByTestId("source-list");
    expect(details.tagName).toBe("DETAILS");
  });

  it("shows citation count in the summary", () => {
    render(<SourceList citations={citations} />);
    expect(screen.getByTestId("source-list-summary")).toHaveTextContent(
      `Sources (${citations.length})`,
    );
  });

  it("is collapsed by default", () => {
    render(<SourceList citations={citations} />);
    const details = screen.getByTestId("source-list") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it("is expanded when defaultExpanded=true", () => {
    render(<SourceList citations={citations} defaultExpanded />);
    const details = screen.getByTestId("source-list") as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it("renders each citation's source and detail", () => {
    render(<SourceList citations={citations} defaultExpanded />);
    expect(screen.getByText(CITATION_GARCHOMP.source)).toBeInTheDocument();
    expect(screen.getByText(/base speed: 102/)).toBeInTheDocument();
    expect(screen.getByText(CITATION_EARTHQUAKE.source)).toBeInTheDocument();
    expect(screen.getByText(/power: 100/)).toBeInTheDocument();
  });

  it("renders a link for citations with endpoint_url", () => {
    render(<SourceList citations={citations} defaultExpanded />);
    const link = screen.getByTestId("citation-link-0");
    expect(link).toHaveAttribute("href", CITATION_GARCHOMP.endpoint_url);
  });

  it("does not render a link for citations without endpoint_url", () => {
    render(<SourceList citations={citations} defaultExpanded />);
    // CITATION_EARTHQUAKE has no endpoint_url → no link for index 1
    expect(screen.queryByTestId("citation-link-1")).not.toBeInTheDocument();
  });

  it("renders an empty list without crashing", () => {
    render(<SourceList citations={[]} />);
    expect(screen.getByTestId("source-list-summary")).toHaveTextContent(
      "Sources (0)",
    );
  });
});
