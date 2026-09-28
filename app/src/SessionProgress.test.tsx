// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionProgress } from "./SessionProgress";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("keeps summary countdowns in native time and accepts an updated clock after sleep", async () => {
  vi.useFakeTimers();
  const wall = 1_800_000_000_000;
  vi.setSystemTime(wall);
  const session = {id:"exam",title:"exam",kind:"mock_exam" as const,count:1,answered:0,clockNow:wall,deadlineAt:wall+60_000};
  const onExpired = vi.fn();
  const view = render(<SessionProgress session={session} onExpired={onExpired}/>);
  vi.setSystemTime(wall + 7_200_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText(/剩余/).textContent).toContain("0 分 59 秒");
  expect(onExpired).not.toHaveBeenCalled();
  vi.setSystemTime(wall - 120_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText(/剩余/).textContent).toContain("0 分 58 秒");
  view.rerender(<SessionProgress session={{...session,clockNow:wall+60_000}} onExpired={onExpired}/>);
  expect(onExpired).toHaveBeenCalledOnce();
  expect(screen.getByText(/已到交卷时间/)).toBeTruthy();
});
