import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import ModelSelector from "./ModelSelector";
import { MODELS } from "@/agent/models";

function setup(props: Partial<Parameters<typeof ModelSelector>[0]> = {}) {
  const onChange = vi.fn();
  render(<ModelSelector value="claude" onChange={onChange} {...props} />);
  return {
    onChange,
    select: screen.getByTestId("model-selector") as HTMLSelectElement,
  };
}

describe("ModelSelector", () => {
  it("renders every registry model as an option", () => {
    setup();
    for (const m of MODELS) {
      expect(
        screen.getByRole("option", { name: m.label }),
      ).toBeInTheDocument();
    }
  });

  it("reflects the selected value", () => {
    const { select } = setup({ value: "grok-4.3" });
    expect(select.value).toBe("grok-4.3");
  });

  it("fires onChange with the chosen model key", () => {
    const { onChange, select } = setup();
    fireEvent.change(select, { target: { value: "gpt-5.5" } });
    expect(onChange).toHaveBeenCalledWith("gpt-5.5");
  });
});
