import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PracticeStore } from "./store.js";
import { Sessions } from "./sessions.js";
import { SessionClock } from "./session-clock.js";
import { previewPaper } from "./paper.js";
import { readQuestions } from "./questions.js";
import { object } from "./question-contract.js";

const stores: PracticeStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) { store.close(); rmSync(store.directory, { recursive: true, force: true }); } });
async function setup(kind: "practice" | "self_test" | "mock_exam" = "self_test") {
  const store = new PracticeStore(mkdtempSync(join(tmpdir(), "practiq-listening-"))); stores.push(store);
  const preview = object(await store.packages.previewZip(new URL("../fixtures/english.zip", import.meta.url).pathname));
  const bank = store.packages.import(String(preview.ticket), null, String(preview.title));
  const root = readQuestions(store.db, store.assets, [bank.bankId]).find(row => row.question.answerMode === "listening")!;
  const paper = previewPaper(store.db, store.assets, { bank_ids: [bank.bankId], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: [root.id], random: false, total_cents: kind === "practice" ? 0 : 200 });
  let wall = 1_800_000_000_000, tick = 1000n;
  const sessions = new Sessions(store.db, store.assets, new SessionClock(() => ({ wall, tick })));
  const session = sessions.createPaper({ question_ids: paper.questionIds, digest: paper.digest, kind, minutes: kind === "mock_exam" ? 1 : null, scores: paper.scores, total_cents: kind === "practice" ? 0 : 200 });
  return { store, sessions, session, root, clock: (nextWall: number, nextTick: number) => { wall = nextWall; tick = BigInt(nextTick); } };
}

describe.skipIf(process.platform !== "darwin")("listening playback parity", () => {
  it("routes state/start/progress through the public command without writing on state reads", async () => {
    const { store, session, root } = await setup("practice");
    const request = (action: string, position?: number) => store.request({ type: "listening_playback", id: session.id, question_id: root.id, action, ...(position === undefined ? {} : { position }) });
    expect(request("state")).toEqual({ used: 0, position: 0, active: false, limit: 2, restricted: false });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM listening_playback").get()!.count).toBe(0);
    expect(request("start")).toMatchObject({ used: 1, active: true });
    expect(request("progress", .1)).toMatchObject({ used: 1, position: .1 });
    expect(() => request("seek", .2)).toThrow();
    expect(() => request("pause", NaN)).toThrow();
    expect(() => request("progress", 86401)).toThrow();
  });

  it("preserves a single seek allowance through clock changes, pauses and reopen", async () => {
    const { store, sessions, session, root, clock } = await setup();
    const play = (action: "state" | "start" | "progress" | "pause" | "end", position?: number) => sessions.listeningPlayback(session.id, root.id, action, position);
    expect(play("start")).toMatchObject({ used: 1, restricted: true });
    expect(play("progress", 1.8).position).toBe(1.8);
    expect(play("progress", 1.56).position).toBe(1.8);
    expect(() => play("progress", 1.32)).toThrow();
    expect(() => play("progress", 2.8)).toThrow();
    store.db.prepare("UPDATE listening_playback SET updated_at=updated_at-60000").run();
    expect(play("start").used).toBe(1);
    expect(() => play("progress", 2.8)).toThrow();
    play("pause", 1.8); clock(1_800_000_000_000 + 7_200_000, 61000);
    expect(() => play("progress", 2.8)).toThrow();
    expect(play("start")).toMatchObject({ used: 1, position: 1.8 });
    expect(() => play("progress", 2.8)).toThrow();
    clock(1_800_000_000_000 - 120000, 64000);
    expect(play("progress", 3).position).toBe(3);
    const reopened = new Sessions(store.db, store.assets, new SessionClock(() => ({ wall: 1_800_000_000_000 + 7_200_000, tick: 0n })));
    expect(reopened.listeningPlayback(session.id, root.id, "start").used).toBe(1);
    expect(() => reopened.listeningPlayback(session.id, root.id, "progress", 6)).toThrow();
  });

  it("enforces play limits and frozen question ownership after live edits and deletion", async () => {
    const { store, sessions, session, root } = await setup();
    const play = (action: "start" | "end" | "state", position?: number) => sessions.listeningPlayback(session.id, root.id, action, position);
    store.db.prepare("UPDATE listening_questions SET play_count=10 WHERE question_id=?").run(root.id);
    for (let count = 1; count <= 2; count++) { expect(play("start").used).toBe(count); play("end", 0); }
    const before = store.db.prepare("SELECT * FROM listening_playback").all();
    expect(() => play("start")).toThrow();
    expect(store.db.prepare("SELECT * FROM listening_playback").all()).toEqual(before);
    expect(() => sessions.listeningPlayback(session.id, "other-question", "start")).toThrow();
    store.deleteBank(root.bankId); expect(play("state").used).toBe(2);
    sessions.submit(session.id, false); expect(() => play("end", 0)).toThrow();
  });

  it("does not rehash audio on progress, and missing audio never consumes a new play", async () => {
    const { store, sessions, session, root } = await setup("practice");
    sessions.listeningPlayback(session.id, root.id, "start");
    const read = vi.spyOn(store.assets, "bytes");
    unlinkSync(store.assets.path(root.question.audioRef!.sha256));
    expect(sessions.listeningPlayback(session.id, root.id, "progress", .1).position).toBe(.1);
    expect(read).not.toHaveBeenCalled();
    expect(() => sessions.listeningPlayback(session.id, root.id, "start")).toThrow();
    expect(sessions.listeningPlayback(session.id, root.id, "state").used).toBe(1);
  });

  it("expires timed exams before accepting playback and keeps state readable", async () => {
    const { sessions, session, root, clock } = await setup("mock_exam");
    sessions.listeningPlayback(session.id, root.id, "start");
    clock(1_800_000_000_000, 61000);
    expect(() => sessions.listeningPlayback(session.id, root.id, "progress", .1)).toThrow();
    expect(sessions.listeningPlayback(session.id, root.id, "state")).toMatchObject({ used: 1, restricted: false });
  });
});
