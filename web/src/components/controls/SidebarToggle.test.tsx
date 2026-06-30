import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import SidebarToggle from "./SidebarToggle";

function setup(props: Partial<Parameters<typeof SidebarToggle>[0]> = {}) {
  const onToggle = vi.fn();
  render(
    <SidebarToggle
      collapsed={false}
      onToggle={onToggle}
      controlsId="history-sidebar"
      {...props}
    />,
  );
  return { onToggle, button: screen.getByTestId("sidebar-toggle") };
}

describe("SidebarToggle", () => {
  it("reflects the expanded state via aria-expanded and label", () => {
    const { button } = setup({ collapsed: false });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-label", "Collapse conversation history");
    expect(button).toHaveAttribute("title", "Collapse conversation history");
  });

  it("reflects the collapsed state via aria-expanded and label", () => {
    const { button } = setup({ collapsed: true });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-label", "Show conversation history");
    expect(button).toHaveAttribute("title", "Show conversation history");
  });

  it("points aria-controls at the controlled element", () => {
    const { button } = setup({ controlsId: "history-sidebar" });
    expect(button).toHaveAttribute("aria-controls", "history-sidebar");
  });

  it("calls onToggle when clicked", () => {
    const { onToggle, button } = setup();
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
