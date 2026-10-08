import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import ResultReview, { Markdown } from "./ResultReview";
import { Client } from "./api";
import { preview, question, task } from "./test-fixtures";

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("react-markdown", () => ({ default: ({ children }: { children: string }) => {
  parse(children);
  return <span>{children}</span>;
} }));

it("reuses unchanged Markdown across parent updates and renders changed or null content", () => {
  parse.mockClear();
  const view = render(<Markdown text="$x^2$" />);
  for (let tick = 0; tick < 100; tick++) view.rerender(<Markdown text="$x^2$" />);
  expect(parse).toHaveBeenCalledTimes(1);
  view.rerender(<Markdown text="$y^2$" />);
  expect(parse).toHaveBeenCalledTimes(2);
  expect(parse).toHaveBeenLastCalledWith("$y^2$");
  view.rerender(<Markdown text={null} />);
  expect(screen.getByText("未提供（null）")).toBeTruthy();
  expect(parse).toHaveBeenCalledTimes(2);
});

it("serializes complete records only after opening and reuses them on reopen", async () => {
  const user = userEvent.setup();
  const record = question({ id: "lazy-record", stem: "Lazy question", parentId: null, optionSourceId: null });
  const client = new Client("fake");
  const current = { ...preview, units: [{ ...preview.units[0], questions: [record] }] };
  const stringify = vi.spyOn(JSON, "stringify");
  const view = render(<ResultReview task={task} preview={current} client={client} />);
  const calls = () => stringify.mock.calls.filter(([value]) => value === record).length;
  expect(calls()).toBe(0);
  await user.click(screen.getByText("Lazy question", { selector: "summary span" }));
  expect(await screen.findByRole("heading", { name: "完整题干" })).toBeTruthy();
  expect(calls()).toBe(0);
  const summary = screen.getByText("完整结构化记录（只读）");
  await user.click(summary);
  await waitFor(() => expect(calls()).toBe(1));
  expect(screen.getByText(/"id": "lazy-record"/)).toBeTruthy();
  await user.click(summary);
  await user.click(summary);
  await act(async () => view.rerender(<ResultReview task={{ ...task }} preview={current} client={client} />));
  expect(calls()).toBe(1);
  const changed = { ...record, sourceText: "Updated source" };
  view.rerender(<ResultReview task={task} preview={{ ...current, units: [{ ...current.units[0], questions: [changed] }] }} client={client} />);
  expect(await screen.findByText(/"sourceText": "Updated source"/)).toBeTruthy();
  stringify.mockRestore();
});
