import { afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";

// Mock the (canvas-using) image util so the attach path is testable under jsdom
// without a real canvas. Each accepted file maps to one PendingImage.
vi.mock("@/lib/image-attachments", () => ({
  MAX_ATTACHMENTS: 4,
  filesToPendingImages: vi.fn(),
}));

afterEach(() => cleanup());

import Composer from "./Composer";
import type { ComposerProps, PendingImage } from "@/components/types";
import { filesToPendingImages } from "@/lib/image-attachments";

/** Minimal props with sensible defaults; override per test. */
function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    onSend: () => {},
    ...overrides,
  };
}

let imgSeq = 0;
function fakeImage(name: string): PendingImage {
  imgSeq += 1;
  return {
    id: `img-${imgSeq}`,
    mimeType: "image/webp",
    data: `BASE64-${imgSeq}`,
    previewUrl: `data:image/webp;base64,BASE64-${imgSeq}`,
    name,
  };
}

/** Default processor: one PendingImage per accepted file, no errors. */
function mockProcessing() {
  vi.mocked(filesToPendingImages).mockImplementation(async (files: File[]) => ({
    images: files.map((f) => fakeImage(f.name)),
    errors: [],
  }));
}

function pngFile(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
    type: "image/png",
  });
}

function attach(files: File[]) {
  fireEvent.change(screen.getByTestId("composer-file-input"), {
    target: { files },
  });
}

describe("Composer — send / stop button swap", () => {
  it("renders the Send button (not Stop) when not streaming", () => {
    render(<Composer {...props()} />);
    expect(screen.getByTestId("composer-send")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-stop")).not.toBeInTheDocument();
  });

  it("renders a Stop button (not Send) while streaming", () => {
    render(<Composer {...props({ streaming: true })} />);
    expect(screen.getByTestId("composer-stop")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
  });

  it("calls onStop when the Stop button is clicked", () => {
    const onStop = vi.fn();
    render(<Composer {...props({ streaming: true, onStop })} />);
    fireEvent.click(screen.getByTestId("composer-stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("the Stop button is clickable even when disabled is true (input frozen)", () => {
    // While streaming, the input is disabled but Stop must stay actionable.
    const onStop = vi.fn();
    render(
      <Composer {...props({ streaming: true, disabled: true, onStop })} />,
    );
    const stop = screen.getByTestId("composer-stop");
    expect(stop).not.toBeDisabled();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe("Composer — submit + prefill", () => {
  it("sends a trimmed message (no images) and clears the input on submit", () => {
    const onSend = vi.fn();
    render(<Composer {...props({ onSend })} />);
    const input = screen.getByTestId("composer-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Garchomp speed?  " } });
    fireEvent.submit(screen.getByTestId("composer"));
    expect(onSend).toHaveBeenCalledWith("Garchomp speed?", []);
    expect(input.value).toBe("");
  });

  it("submits on a bare Enter (desktop / fine pointer)", () => {
    // jsdom's matchMedia defaults to matches:false, so (pointer: coarse) is
    // false here — i.e. the desktop path.
    const onSend = vi.fn();
    render(<Composer {...props({ onSend })} />);
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Garchomp speed?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("Garchomp speed?", []);
    expect(input.value).toBe("");
  });

  it("does NOT submit on Shift+Enter (newline inserted instead)", () => {
    const onSend = vi.fn();
    render(<Composer {...props({ onSend })} />);
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    // Field is preserved (not cleared by a submit).
    expect(input.value).toBe("line one");
  });

  it("does NOT submit on Enter while composing (IME candidate)", () => {
    const onSend = vi.fn();
    render(<Composer {...props({ onSend })} />);
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "にほんご" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does NOT submit on Enter on a touch device (coarse pointer)", () => {
    // Simulate a touch device: (pointer: coarse) matches.
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes("coarse"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const onSend = vi.fn();
      render(<Composer {...props({ onSend })} />);
      const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "mobile question" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });

  it("loads a fresh prefill object's text into the input", () => {
    const { rerender } = render(<Composer {...props({ prefill: null })} />);
    const input = screen.getByTestId("composer-input") as HTMLInputElement;
    expect(input.value).toBe("");
    rerender(<Composer {...props({ prefill: { text: "Which Fire-types?" } })} />);
    expect(input.value).toBe("Which Fire-types?");
  });

  it("re-applies the same text when a new prefill object identity arrives", () => {
    const { rerender } = render(
      <Composer {...props({ prefill: { text: "redo me" } })} />,
    );
    const input = screen.getByTestId("composer-input") as HTMLInputElement;
    expect(input.value).toBe("redo me");
    // User edits the field away…
    fireEvent.change(input, { target: { value: "edited" } });
    expect(input.value).toBe("edited");
    // …a brand-new prefill object with the same text reloads it (identity change).
    rerender(<Composer {...props({ prefill: { text: "redo me" } })} />);
    expect(input.value).toBe("redo me");
  });
});

describe("Composer — image attachments", () => {
  it("attaching an image shows a thumbnail and enables Send with empty text", async () => {
    mockProcessing();
    render(<Composer {...props()} />);
    expect(screen.getByTestId("composer-send")).toBeDisabled();

    attach([pngFile("team.png")]);

    const strip = await screen.findByTestId("composer-attachments");
    expect(within(strip).getAllByRole("img")).toHaveLength(1);
    // An image-only message is sendable even with an empty text box.
    expect(screen.getByTestId("composer-send")).not.toBeDisabled();
  });

  it("submits an image-only message (empty text) with the attachments, then clears", async () => {
    mockProcessing();
    const onSend = vi.fn();
    render(<Composer {...props({ onSend })} />);
    attach([pngFile("team.png")]);
    await screen.findByTestId("composer-attachments");

    fireEvent.click(screen.getByTestId("composer-send"));

    expect(onSend).toHaveBeenCalledTimes(1);
    const [msg, images] = onSend.mock.calls[0]!;
    expect(msg).toBe("");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: "image/webp", name: "team.png" });
    // Cleared after send.
    expect(screen.queryByTestId("composer-attachments")).not.toBeInTheDocument();
  });

  it("removes a thumbnail when its × is clicked", async () => {
    mockProcessing();
    render(<Composer {...props()} />);
    attach([pngFile("a.png"), pngFile("b.png")]);
    const strip = await screen.findByTestId("composer-attachments");
    expect(within(strip).getAllByRole("img")).toHaveLength(2);

    fireEvent.click(within(strip).getAllByRole("button")[0]!);
    await waitFor(() =>
      expect(
        within(screen.getByTestId("composer-attachments")).getAllByRole("img"),
      ).toHaveLength(1),
    );
  });

  it("caps attachments at 4 and surfaces an over-limit message", async () => {
    mockProcessing();
    render(<Composer {...props()} />);
    attach([
      pngFile("1.png"),
      pngFile("2.png"),
      pngFile("3.png"),
      pngFile("4.png"),
      pngFile("5.png"),
    ]);
    const strip = await screen.findByTestId("composer-attachments");
    expect(within(strip).getAllByRole("img")).toHaveLength(4);
    expect(screen.getByRole("alert")).toHaveTextContent("up to 4 images");
    // The attach button is disabled at capacity.
    expect(screen.getByTestId("composer-attach")).toBeDisabled();
  });

  it("surfaces a decode error returned by the processor", async () => {
    vi.mocked(filesToPendingImages).mockResolvedValue({
      images: [],
      errors: [
        'Couldn\'t read "heic.HEIC". Try a PNG, JPEG, or WebP screenshot.',
      ],
    });
    render(<Composer {...props()} />);
    attach([pngFile("heic.HEIC")]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read");
    // Nothing attached, so an empty message stays unsendable.
    expect(screen.getByTestId("composer-send")).toBeDisabled();
  });

  it("attaches an image pasted into the input", async () => {
    mockProcessing();
    render(<Composer {...props()} />);
    const file = pngFile("pasted.png");
    fireEvent.paste(screen.getByTestId("composer-input"), {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      },
    });
    const strip = await screen.findByTestId("composer-attachments");
    expect(within(strip).getAllByRole("img")).toHaveLength(1);
  });
});
