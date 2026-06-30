import { afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const search = vi.hoisted(() => ({ searchEntities: vi.fn() }));
vi.mock("@/lib/api/search-client", () => search);

import EntityPicker from "./EntityPicker";
import { NATURE_OPTIONS } from "./dex-constants";

afterEach(() => {
  cleanup();
  search.searchEntities.mockReset();
});

describe("EntityPicker", () => {
  it("never commits free-typed text and reverts invalid text on blur", () => {
    const onChange = vi.fn();
    search.searchEntities.mockResolvedValue([]);
    render(
      <EntityPicker
        kind="pokemon"
        format="scarlet-violet"
        value=""
        onChange={onChange}
        testid="member-0-species"
      />,
    );
    const input = screen.getByTestId("member-0-species") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "dragapult" } });
    // Typing alone must not commit (require-selection).
    expect(onChange).not.toHaveBeenCalled();
    // Blurring invalid free text reverts the field, still without committing.
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("commits an exact name/slug match on blur without clicking", async () => {
    const onChange = vi.fn();
    search.searchEntities.mockResolvedValue([
      { slug: "garchomp", display_name: "Garchomp", kind: "pokemon" },
    ]);
    render(
      <EntityPicker
        kind="pokemon"
        format="scarlet-violet"
        value=""
        onChange={onChange}
        testid="member-0-species"
      />,
    );
    const input = screen.getByTestId("member-0-species");
    fireEvent.change(input, { target: { value: "garchomp" } });
    await screen.findByText("Garchomp"); // wait for the debounced results
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith("garchomp");
  });

  it("commits the empty string when a committed field is cleared", () => {
    const onChange = vi.fn();
    render(
      <EntityPicker
        options={NATURE_OPTIONS}
        format="scarlet-violet"
        value="jolly"
        onChange={onChange}
        testid="member-0-nature"
      />,
    );
    const input = screen.getByTestId("member-0-nature");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("shows network suggestions and selects a slug on click", async () => {
    const onChange = vi.fn();
    search.searchEntities.mockResolvedValue([
      { slug: "garchomp", display_name: "Garchomp", kind: "pokemon" },
    ]);
    render(
      <EntityPicker
        kind="pokemon"
        format="scarlet-violet"
        value=""
        onChange={onChange}
        testid="member-0-species"
      />,
    );
    fireEvent.change(screen.getByTestId("member-0-species"), {
      target: { value: "garch" },
    });
    const option = await screen.findByText("Garchomp");
    fireEvent.mouseDown(option);
    expect(onChange).toHaveBeenLastCalledWith("garchomp");
  });

  it("filters a static option list locally and selects via keyboard", () => {
    const onChange = vi.fn();
    render(
      <EntityPicker
        options={NATURE_OPTIONS}
        format="scarlet-violet"
        value=""
        onChange={onChange}
        testid="member-0-nature"
      />,
    );
    const input = screen.getByTestId("member-0-nature");
    fireEvent.change(input, { target: { value: "jol" } });
    expect(screen.getByText("Jolly")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("jolly");
    // The static list never calls the network.
    expect(search.searchEntities).not.toHaveBeenCalled();
  });

  it("does not query the network for a blank query", async () => {
    render(
      <EntityPicker
        kind="item"
        format="scarlet-violet"
        value=""
        onChange={vi.fn()}
        testid="member-0-item"
      />,
    );
    fireEvent.focus(screen.getByTestId("member-0-item"));
    await waitFor(() => {
      expect(search.searchEntities).not.toHaveBeenCalled();
    });
  });
});
