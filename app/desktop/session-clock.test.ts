import { expect, it } from "vitest";
import { SessionClock } from "./session-clock.js";

it("ignores wall-clock jumps and includes monotonic sleep time without changing its time domain", () => {
  let reading = { wall: 1000, tick: 100n };
  const clock = new SessionClock(() => reading);
  expect(clock.started).toBe(false);
  expect(clock.atLeast(2000)).toBe(2000);
  reading = { wall: -100000, tick: 110n };
  expect(clock.now()).toBe(2010);
  reading = { wall: 900000, tick: 60100n };
  expect(clock.atLeast(1000000)).toBe(62000);
});
