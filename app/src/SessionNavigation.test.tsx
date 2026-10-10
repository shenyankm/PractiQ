// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { api, type Session } from "./api";
import { Practice } from "./Practice";
import fixture from "../fixtures/session-navigation.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); });

function History({ initial }: { initial: Session }) {
  const [session, setSession] = useState(initial);
  return <Practice session={session} onSession={setSession} run={job => { void job(); }} flushRef={{ current: async () => {} }} />;
}

it.each(["empty", "partial", "full"] as const)("expands the actual native %s response and navigates finished history", async kind => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await api({ type: "restore" });
  vi.mocked(invoke).mockResolvedValueOnce(structuredClone(fixture.baseline));
  const initial = await api({ type: "session", id: fixture.baseline.id });
  render(<History initial={initial} />);
  vi.mocked(invoke).mockResolvedValueOnce(structuredClone(fixture[kind]));
  const target = fixture[kind].position;
  await userEvent.click(screen.getByRole("button", { name: `转到第 ${target + 1} 题，已跳过` }));
  expect(await screen.findByRole("heading", { name: `第 ${target + 1} / 3 题` })).toBeTruthy();
  expect(screen.getByText(initial.attempts[target].snapshot.question.stem!)).toBeTruthy();
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("request", expect.objectContaining({ request: {
    type: "position", id: initial.id, position: target, snapshot_key: `${initial.snapshotKey}:${initial.attemptKey}`,
  } }));
});
