// @vitest-environment jsdom
/**
 * Storefront hero scene: an illustration (hidden from assistive tech, with a
 * text description), one camera view pressed at a time, and an evening-light
 * toggle — all plain buttons, operable by keyboard.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CafeScene, SCENE_VIEWS } from "@/features/guest/components/CafeScene";

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("CafeScene", () => {
  it("describes the illustration in text and hides the drawing itself", () => {
    const { container } = render(<CafeScene />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(/Illustration of the Coders' Cafe interior/)).toBeInTheDocument();
  });

  it("switches camera views (one pressed at a time) and toggles evening light", async () => {
    const user = userEvent.setup();
    const { container } = render(<CafeScene />);
    const group = screen.getByRole("group", { name: "Look around the café" });
    expect(group.querySelectorAll("button")).toHaveLength(SCENE_VIEWS.length);
    expect(screen.getByRole("button", { name: "Street" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Booth" }));
    expect(screen.getByRole("button", { name: "Booth" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Street" })).toHaveAttribute("aria-pressed", "false");

    const light = screen.getByRole("button", { name: "Evening light" });
    expect(light).toHaveAttribute("aria-pressed", "false");
    await user.click(light);
    expect(light).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".sf-scene")).toHaveAttribute("data-evening", "true");
  });
});
