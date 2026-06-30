import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import TypeBadge from "./TypeBadge";
import { TYPE_NAMES } from "@/agent/schemas";

describe("TypeBadge", () => {
  it("renders the type name as text", () => {
    render(<TypeBadge type="dragon" />);
    expect(screen.getByText("dragon")).toBeInTheDocument();
  });

  it("applies the type-specific CSS class", () => {
    render(<TypeBadge type="fire" />);
    const badge = screen.getByTestId("type-badge-fire");
    expect(badge.className).toContain("type-badge--fire");
  });

  it("has a data-testid with the type slug", () => {
    render(<TypeBadge type="water" />);
    expect(screen.getByTestId("type-badge-water")).toBeInTheDocument();
  });

  it("renders all 18 canonical types without crashing", () => {
    const { unmount } = render(
      <div>
        {(TYPE_NAMES as readonly string[]).map((t) => (
          <TypeBadge key={t} type={t as import("@/agent/schemas").TypeName} />
        ))}
      </div>,
    );
    // Each type should produce a visible badge
    for (const t of TYPE_NAMES) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    unmount();
  });

  it("renders the 'ground' type badge", () => {
    render(<TypeBadge type="ground" />);
    expect(screen.getByTestId("type-badge-ground")).toBeInTheDocument();
    expect(screen.getByText("ground")).toBeInTheDocument();
  });
});
