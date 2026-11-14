import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { LISTENING_ADDRESS_ROLE, listeningAddress, listeningBlocks, playbackAddress } from "../../shared/listening.js";
import { PracticeStore } from "./store.js";
import { validateQuestion } from "./question-contract.js";
import { readQuestions, saveQuestionTree, thaw } from "./questions.js";
import { prepareListeningQr } from "./image-preparation.js";
import { previewPaper } from "./paper.js";
import { Backups } from "./backup.js";
import { validateContract } from "./contracts.js";

const stores: PracticeStore[] = [];
const create = () => { const store = new PracticeStore(mkdtempSync(join(tmpdir(), "practiq-listening-links-"))); stores.push(store); return store; };
afterEach(() => { for (const store of stores.splice(0)) { store.close(); rmSync(store.directory, { recursive: true, force: true }); } });
const address = "https://example.com/listening.wav";
const question = () => validateQuestion({ id: "listening", stem: "Listen carefully", answerMode: "listening", questionKind: "listening", contentBlocks: listeningBlocks([], address), needsReview: false });
const child = () => validateQuestion({ id: "child", parentId: "listening", stem: "Choose", answerMode: "choice", choiceVariant: "single", options: [{ label: "A", content: "One" }, { label: "B", content: "Two" }], answerPayload: { correct: ["A"] }, needsReview: false });

it.each(["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/a", "https://u:p@example.com/a", "http://example.com:8080/a", "http://localhost/a", "http://localhost./a", "http://a.local/a", "http://127.1/a", "http://2130706433/a", "http://10.0.0.1/a", "http://169.254.169.254/a", "http://100.64.0.1/a", "http://192.0.0.1/a", "http://192.88.99.1/a", "http://198.18.0.1/a", "http://224.0.0.1/a", "http://240.0.0.1/a", "http://[::1]/a", "http://[::ffff:127.0.0.1]/a", "http://[fc00::1]/a", "http://[2002:7f00:1::]/a", "http://[2001:db8::1]/a", "http://[3fff:1::1]/a", "https://example.com/a\n"])("rejects unsafe playback address %s before any I/O", raw => {
  expect(playbackAddress(raw)).toBeNull();
  expect(() => validateQuestion({ ...question(), contentBlocks: [{ partType: "text", role: LISTENING_ADDRESS_ROLE, textValue: raw }] })).toThrow();
});

it("validates canonical public addresses, uniqueness and listening ownership", () => {
  for (const raw of [address, "http://8.8.8.8/a", "https://[2606:4700::1111]/a"]) expect(playbackAddress(raw)).toBe(raw);
  expect(playbackAddress("  https://example.com/a#track  ")).toBe("https://example.com/a");
  const q = question(); expect(q.missingFields).not.toContain("media");
  expect(() => validateQuestion({ ...q, answerMode: "reading", questionKind: null })).toThrow();
  expect(() => validateQuestion({ ...q, contentBlocks: [...q.contentBlocks, ...q.contentBlocks] })).toThrow();
  expect(listeningAddress({ contentBlocks: listeningBlocks(q.contentBlocks, null) })).toBeNull();
  expect(() => validateQuestion({ ...q, contentBlocks: [{ partType: "text", role: LISTENING_ADDRESS_ROLE, textValue: null, jsonValue: { arbitrary: true } }] })).toThrow();
});

it("uses the shared native request and link schemas for listening boundaries", () => {
  for (const request of [{ type: "pick_audio_qr" }, { type: "decode_audio_qr", hash: "a".repeat(64) }, { type: "listening_links", url: address }, { type: "load_listening_audio", url: address }]) expect(() => validateContract("DesktopListeningRequest", request)).not.toThrow();
  for (const request of [{ type: "pick_audio_qr", path: "/private/file" }, { type: "decode_audio_qr", hash: "../file" }, { type: "load_listening_audio", url: 1 }, { type: "listening_links", url: "a".repeat(8193) }, { type: "pick_audio" }]) expect(() => validateContract("DesktopListeningRequest", request)).toThrow();
  expect(() => validateContract("DesktopListeningLink", { url: address, label: "" })).not.toThrow();
  expect(() => validateContract("DesktopListeningLink", { url: address, label: "a".repeat(161) })).toThrow();
});

it("creates new example banks without recording files while retaining every question type", async () => {
  const store = create(), imported = await store.packages.addExample(new URL("../fixtures/all-types-no-recordings.zip", import.meta.url).pathname);
  const rows = readQuestions(store.db, store.assets, [imported.bankId]), listening = rows.find(row => row.question.answerMode === "listening")!;
  expect(imported.count).toBe(20); expect(new Set(rows.map(row => row.question.answerMode)).size).toBe(11);
  expect(listening.question.audioRef).toBeNull(); expect(listening.question.missingFields).toContain("media"); expect(listening.question.needsReview).toBe(true);
  expect(store.db.prepare("SELECT * FROM assets WHERE media LIKE 'audio/%'").all()).toEqual([]);
});

it("retains playback addresses through live edits, frozen exam controls, ZIPs and full restore without audio files", async () => {
  const store = create(), bank = store.saveBank(null, "Listening", ""), root = question();
  saveQuestionTree(store.db, store.assets, bank, null, [root, child()]);
  const paper = previewPaper(store.db, store.assets, { bank_ids: [bank], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: [root.id!], random: false, total_cents: 100 });
  const session = store.sessions.createPaper({ question_ids: paper.questionIds, digest: paper.digest, scores: paper.scores, total_cents: 100, kind: "self_test", minutes: null });
  expect(store.sessions.listeningPlayback(session.id, root.id!, "start")).toMatchObject({ used: 1, restricted: true });
  expect(() => store.sessions.listeningPlayback(session.id, root.id!, "progress", 10)).toThrow();
  store.sessions.listeningPlayback(session.id, root.id!, "end", 0);
  saveQuestionTree(store.db, store.assets, bank, root.id!, [{ ...root, contentBlocks: listeningBlocks([], "https://example.com/new.wav") }, child()]);
  expect(listeningAddress(thaw(store.sessions.document(session.id)).find(row => row.id === root.id)!.question)).toBe(address);
  const output = create(), zip = join(output.directory, "bank.zip"); await store.packages.export(bank, zip);
  const other = create(), preview = await other.packages.previewZip(zip) as { ticket: string; title: string };
  const imported = other.packages.import(preview.ticket, null, preview.title);
  expect(listeningAddress(readQuestions(other.db, other.assets, [imported.bankId]).find(row => row.question.answerMode === "listening")!.question)).toBe("https://example.com/new.wav");
  const backup = join(output.directory, "backup.zip"); await new Backups(store).export(backup);
  await new Backups(other).restore(backup, false);
  expect(listeningAddress(thaw(other.sessions.document(session.id)).find(row => row.id === root.id)!.question)).toBe(address);
  expect(other.sessions.listeningPlayback(session.id, root.id!, "start").used).toBe(2);
  other.sessions.listeningPlayback(session.id, root.id!, "end", 0);
  expect(() => other.sessions.listeningPlayback(session.id, root.id!, "start")).toThrow();
  for (const value of [store, other]) {
    expect(value.db.prepare("SELECT * FROM assets").all()).toEqual([]);
    expect(existsSync(join(value.directory, "assets")) ? readdirSync(join(value.directory, "assets")) : []).toEqual([]);
    expect(value.db.prepare("PRAGMA user_version").get()!.user_version).toBe(11);
  }
});

it("decodes local QR images in the bounded worker without persisting image or audio resources", async () => {
  const source = readFileSync(new URL("../fixtures/listening-qr.png", import.meta.url));
  expect(await prepareListeningQr(() => source)).toEqual([{ url: address, label: "" }]);
  const second = readFileSync(new URL("../fixtures/listening-qr-second.png", import.meta.url)), meta = await sharp(source).metadata(), secondMeta = await sharp(second).metadata(), width = meta.width!, height = Math.max(meta.height!, secondMeta.height!);
  const multiple = await sharp({ create: { width: width + secondMeta.width! + 20, height, channels: 3, background: "white" } }).composite([{ input: source, left: 0, top: 0 }, { input: second, left: width + 20, top: 0 }]).png().toBuffer();
  expect((await prepareListeningQr(() => multiple)).map(link => link.url).sort()).toEqual([address, "https://example.com/second.wav"]);
  await expect(prepareListeningQr(() => readFileSync(new URL("../fixtures/listening-qr-private.png", import.meta.url)))).rejects.toMatchObject({ code: "LOCAL_AUDIO_QR_INVALID" });
  await expect(prepareListeningQr(() => Buffer.from("not an image"))).rejects.toMatchObject({ code: "LOCAL_AUDIO_QR_INVALID" });
  const huge = await sharp({ create: { width: 4097, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  await expect(prepareListeningQr(() => huge)).rejects.toMatchObject({ code: "LOCAL_AUDIO_QR_INVALID" });
  const cancelled = new AbortController(); cancelled.abort(); await expect(prepareListeningQr(() => { throw new Error("Must not read"); }, cancelled.signal)).rejects.toThrow();
}, 30000);
