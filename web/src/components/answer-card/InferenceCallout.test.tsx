import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import InferenceCallout from "./InferenceCallout";
import { INFERENCE_SPEED, INFERENCE_LOW_CONFIDENCE } from "@/components/test-fixtures";
import type { Inference } from "@/components/types";

describe("InferenceCallout", () => {
  it("renders nothing when inferences array is empty", () => {
    const { container } = render(<InferenceCallout inferences={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a container when there are inferences", () => {
    render(<InferenceCallout inferences={[INFERENCE_SPEED]} />);
    expect(screen.getByTestId("inference-callout")).toBeInTheDocument();
  });

  it("renders the claim text", () => {
    render(<InferenceCallout inferences={[INFERENCE_SPEED]} />);
    expect(screen.getByText(INFERENCE_SPEED.claim)).toBeInTheDocument();
  });

  it("renders the confidence level", () => {
    render(<InferenceCallout inferences={[INFERENCE_SPEED]} />);
    expect(screen.getByTestId("inference-confidence-0")).toHaveTextContent(
      "[high]",
    );
  });

  it("renders the optional note when present", () => {
    render(<InferenceCallout inferences={[INFERENCE_SPEED]} />);
    expect(screen.getByTestId("inference-note-0")).toHaveTextContent(
      INFERENCE_SPEED.note!,
    );
  });

  it("does not render a note element when note is absent", () => {
    render(<InferenceCallout inferences={[INFERENCE_LOW_CONFIDENCE]} />);
    expect(screen.queryByTestId("inference-note-0")).not.toBeInTheDocument();
  });

  it("applies a confidence-level CSS modifier class", () => {
    render(<InferenceCallout inferences={[INFERENCE_LOW_CONFIDENCE]} />);
    const item = screen.getByTestId("inference-item-0");
    expect(item.className).toContain("inference-callout__item--low");
  });

  it("renders multiple inferences with separate data-testid entries", () => {
    const inferences: Inference[] = [INFERENCE_SPEED, INFERENCE_LOW_CONFIDENCE];
    render(<InferenceCallout inferences={inferences} />);
    expect(screen.getByTestId("inference-item-0")).toBeInTheDocument();
    expect(screen.getByTestId("inference-item-1")).toBeInTheDocument();
  });
});
