// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

afterEach(cleanup);

it("restores a programmatic dialog's mouse invoker without browser default focus", async () => {
  function Example() {
    const [open, setOpen] = useState(false);
    return <><Button onClick={() => setOpen(true)}>Open editor</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined}><DialogTitle>Editor</DialogTitle><input aria-label="Draft" /></DialogContent></Dialog></>;
  }
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole("button", { name: "Open editor" });
  // fireEvent omits the mouse-focus default absent from macOS WebKit.
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await screen.findByRole("dialog", { name: "Editor" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("respects prevented presses, disabled buttons and secondary clicks", () => {
  const prevent = vi.fn((event: MouseEvent<HTMLButtonElement>) => event.preventDefault());
  render(<><Button onMouseDown={prevent}>Prevented</Button><Button disabled>Disabled</Button><Button>Context</Button></>);
  fireEvent.mouseDown(screen.getByRole("button", { name: "Prevented" }), { button: 0 });
  fireEvent.mouseDown(screen.getByRole("button", { name: "Disabled" }), { button: 0 });
  fireEvent.mouseDown(screen.getByRole("button", { name: "Context" }), { button: 2 });
  expect(prevent).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(document.body);
});
