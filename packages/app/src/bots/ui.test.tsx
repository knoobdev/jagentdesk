/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Input } from "./ui";
afterEach(cleanup);
it("shows seeded field text and applies a model reset without losing typed input", () => {
  const change = vi.fn();
  const { rerender } = render(
    <Input label="Identity" value="Existing identity" onChange={change} />,
  );
  const input = screen.getByLabelText("Identity");
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected a text input");
  expect(input.value).toBe("Existing identity");
  fireEvent.change(input, { target: { value: "Edited identity" } });
  expect(change).toHaveBeenCalledWith("Edited identity");
  rerender(<Input label="Identity" value="Reloaded identity" onChange={change} />);
  expect(input.value).toBe("Reloaded identity");
});
it("shows the immutable slug when an existing bot is edited", () => {
  render(<Input label="Slug" value="existing-bot" editable={false} onChange={vi.fn()} />);
  const input = screen.getByLabelText("Slug");
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected a text input");
  expect(input.value).toBe("existing-bot");
  expect(input.readOnly).toBe(true);
});
