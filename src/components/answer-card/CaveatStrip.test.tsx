import { afterEach, describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => cleanup());
import CaveatStrip from "./CaveatStrip";
import {
  GENERATION_BASIS_GEN9,
  GENERATION_BASIS_FALLBACK,
} from "@/components/test-fixtures";

describe("CaveatStrip", () => {
  it("renders nothing when no flags and fallback=false", () => {
    const { container } = render(
      <CaveatStrip
        uncertaintyFlags={[]}
        generationBasis={GENERATION_BASIS_GEN9}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the strip when fallback=true", () => {
    render(
      <CaveatStrip
        uncertaintyFlags={[]}
        generationBasis={GENERATION_BASIS_FALLBACK}
      />,
    );
    expect(screen.getByTestId("caveat-strip")).toBeInTheDocument();
  });

  it("renders the fallback note text when fallback=true", () => {
    render(
      <CaveatStrip
        uncertaintyFlags={[]}
        generationBasis={GENERATION_BASIS_FALLBACK}
      />,
    );
    const banner = screen.getByTestId("caveat-fallback");
    expect(banner).toHaveTextContent(GENERATION_BASIS_FALLBACK.note!);
  });

  it("renders a default fallback message when note is absent", () => {
    const basisNoNote = { generation: "gen-8", fallback: true };
    render(<CaveatStrip uncertaintyFlags={[]} generationBasis={basisNoNote} />);
    const banner = screen.getByTestId("caveat-fallback");
    expect(banner).toHaveTextContent("gen-8");
  });

  it("renders each uncertainty flag", () => {
    const flags = ["Couldn't fetch item data", "Assumed standard ability"];
    render(
      <CaveatStrip
        uncertaintyFlags={flags}
        generationBasis={GENERATION_BASIS_GEN9}
      />,
    );
    expect(screen.getByTestId("caveat-flag-0")).toHaveTextContent(flags[0]);
    expect(screen.getByTestId("caveat-flag-1")).toHaveTextContent(flags[1]);
  });

  it("renders the strip when there are flags but fallback=false", () => {
    render(
      <CaveatStrip
        uncertaintyFlags={["Couldn't reach PokeAPI"]}
        generationBasis={GENERATION_BASIS_GEN9}
      />,
    );
    expect(screen.getByTestId("caveat-strip")).toBeInTheDocument();
    expect(screen.queryByTestId("caveat-fallback")).not.toBeInTheDocument();
  });

  it("renders both fallback and flags when both are present", () => {
    render(
      <CaveatStrip
        uncertaintyFlags={["Some flag"]}
        generationBasis={GENERATION_BASIS_FALLBACK}
      />,
    );
    expect(screen.getByTestId("caveat-fallback")).toBeInTheDocument();
    expect(screen.getByTestId("caveat-flag-0")).toBeInTheDocument();
  });
});
