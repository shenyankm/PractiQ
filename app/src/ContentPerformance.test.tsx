// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Markdown } from "./Content";
const { parse } = vi.hoisted(() => ({parse:vi.fn()}));
vi.mock("react-markdown", () => ({default:({children}:{children:string}) => {parse(children);return <span>{children}</span>;}}));
afterEach(() => {cleanup();vi.clearAllMocks();});

it("does not reparse unchanged formulas across 100 parent updates, but renders new content", () => {
  const view=render(<div><Markdown>{"$x^2$"}</Markdown><span>0</span></div>);
  for(let tick=1;tick<=100;tick++) view.rerender(<div><Markdown>{"$x^2$"}</Markdown><span>{tick}</span></div>);
  expect(parse).toHaveBeenCalledTimes(1);
  view.rerender(<div><Markdown>{"$y^2$"}</Markdown><span>100</span></div>);
  expect(parse).toHaveBeenLastCalledWith("$y^2$");
  expect(parse).toHaveBeenCalledTimes(2);
});
