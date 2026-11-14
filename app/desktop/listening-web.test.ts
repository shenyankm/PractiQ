import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import type { IncomingMessage, RequestOptions } from "node:http";
import { ListeningWeb, pageListeningLinks } from "./listening-web.js";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
const servers: ListeningWeb[] = [];
const web = () => { const value = new ListeningWeb(); servers.push(value); return value; };
const audio = readFileSync(new URL("../fixtures/resources/audio/chimes.wav", import.meta.url));
type Reply = { status?: number; headers?: Record<string, string>; chunks?: Uint8Array[] };
let replies: Reply[] = [];
beforeEach(() => {
  replies = []; mocks.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.request.mockReset().mockImplementation((_url: URL, options: RequestOptions, receive: (response: IncomingMessage) => void) => {
    const reply = replies.shift() ?? { headers: { "content-type": "audio/wav" }, chunks: [audio] };
    const response = Readable.from(reply.chunks ?? []) as IncomingMessage;
    response.statusCode = reply.status ?? 200; response.headers = reply.headers ?? {};
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void; setTimeout: ReturnType<typeof vi.fn> };
    request.end = () => { receive(response); request.emit("response", response); };
    request.destroy = error => { response.destroy(error); request.emit("error", error); request.emit("close"); };
    request.setTimeout = vi.fn().mockReturnValue(request);
    options.signal?.addEventListener("abort", () => { response.destroy(); request.emit("close"); }, { once: true });
    return request;
  });
});
afterEach(() => { for (const server of servers.splice(0)) server.close(); vi.restoreAllMocks(); });

it("loads bounded audio in memory with pinned public DNS and no cookies, credentials or proxy", async () => {
  const result = await web().fetch("https://audio.example.com/track.wav", "audio");
  expect(result).toMatchObject({ mediaType: "audio/wav" });
  expect(Buffer.from((result as { bytes: ArrayBuffer }).bytes)).toEqual(audio);
  expect(mocks.lookup).toHaveBeenCalledWith("audio.example.com", { all: true });
  const options = mocks.request.mock.calls[0][1] as RequestOptions;
  expect(options).toMatchObject({ method: "GET", agent: false, family: 4, headers: { "Accept-Encoding": "identity" } });
  const resolved = vi.fn(); options.lookup!("audio.example.com", {}, resolved);
  expect(resolved).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  expect(Object.keys(options.headers!)).not.toEqual(expect.arrayContaining(["Cookie", "Authorization", "Proxy-Authorization"]));
});

it("rejects private DNS results, including mixed and mapped answers, before opening a socket", async () => {
  for (const address of ["127.0.0.1", "192.168.1.1", "::ffff:127.0.0.1", "2001:db8::1"]) {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }]);
    await expect(web().fetch("https://audio.example.com/a", "audio")).rejects.toMatchObject({ code: "LOCAL_AUDIO_URL_INVALID" });
  }
  expect(mocks.request).not.toHaveBeenCalled();
});

it("tries the remaining pinned public addresses after a connection failure without resolving again", async () => {
  mocks.lookup.mockResolvedValueOnce([{ address: "2606:4700::1111", family: 6 }, { address: "8.8.8.8", family: 4 }]);
  mocks.request.mockImplementationOnce(() => { throw new Error("IPv6 route unavailable"); });
  expect(await web().fetch("https://audio.example.com/a", "audio")).toMatchObject({ mediaType: "audio/wav" });
  expect(mocks.lookup).toHaveBeenCalledOnce(); expect(mocks.request).toHaveBeenCalledTimes(2);
  const resolved = vi.fn(); mocks.request.mock.calls[1][1].lookup("audio.example.com", {}, resolved);
  expect(resolved).toHaveBeenCalledWith(null, "8.8.8.8", 4);
});

it("revalidates every redirect and never connects to a redirected private address", async () => {
  replies.push({ status: 302, headers: { location: "https://cdn.example.com/audio" } });
  mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
  await expect(web().fetch("https://audio.example.com/a", "audio")).rejects.toMatchObject({ code: "LOCAL_AUDIO_URL_INVALID" });
  expect(mocks.request).toHaveBeenCalledTimes(1); expect(mocks.lookup).toHaveBeenCalledTimes(2);
  mocks.request.mockClear(); replies.push({ status: 302, headers: { location: "http://127.0.0.1/private" } });
  await expect(web().fetch("https://audio.example.com/a", "audio")).rejects.toMatchObject({ code: "LOCAL_AUDIO_URL_INVALID" });
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("bounds redirects, declared/chunked bytes, unsupported encodings and response failures without retrying", async () => {
  replies = Array.from({ length: 6 }, () => ({ status: 302, headers: { location: "/again" } }));
  await expect(web().fetch("https://audio.example.com/a", "audio")).rejects.toMatchObject({ code: "LOCAL_AUDIO_DOWNLOAD_FAILED" });
  expect(mocks.request).toHaveBeenCalledTimes(6);
  for (const reply of [
    { headers: { "content-length": String(25 * 1024 * 1024 + 1) } },
    { chunks: [new Uint8Array(25 * 1024 * 1024), new Uint8Array(1)] },
    { headers: { "content-type": "text/html", "content-length": String(2 * 1024 * 1024 + 1) } },
  ]) {
    replies = [reply]; await expect(web().fetch("https://audio.example.com/a", reply.headers?.["content-type"] ? "links" : "audio")).rejects.toMatchObject({ code: "LOCAL_AUDIO_DOWNLOAD_SIZE" });
  }
  for (const reply of [{ status: 401 }, { headers: { "content-encoding": "gzip" } }]) {
    replies = [reply]; await expect(web().fetch("https://audio.example.com/a", "audio")).rejects.toMatchObject({ code: "LOCAL_AUDIO_DOWNLOAD_FAILED" });
  }
  replies = [{ chunks: [Buffer.from("<html>not audio</html>")] }];
  await expect(web().fetch("https://audio.example.com/a", "audio")).rejects.toMatchObject({ code: "LOCAL_AUDIO_INVALID" });
});

it("extracts public HTML links and bases without executing scripts, deduplicates and caps results", async () => {
  const html = Buffer.from('<base href="/media/"><audio src="track.mp3?x=1&amp;y=2"></audio><audio><source src="../second"></audio><a href="track.mp3?x=1&amp;y=2">Duplicate</a><a href="third.WAV">Track three</a><a href="https://127.0.0.1/private.mp3">Private</a><meta property="og:audio" content="//cdn.example.com/fourth"><script>fetch("https://example.com/hidden.mp3")</script>');
  expect(pageListeningLinks(html, "https://example.com/page")).toEqual([
    { url: "https://example.com/media/track.mp3?x=1&y=2", label: "" }, { url: "https://example.com/second", label: "" },
    { url: "https://example.com/media/third.WAV", label: "Track three" }, { url: "https://cdn.example.com/fourth", label: "" },
  ]);
  const many = Array.from({ length: 100 }, (_, i) => `<audio src="/${i}.mp3">`).join("");
  expect(pageListeningLinks(Buffer.from(many), "https://example.com")).toHaveLength(50);
  expect(() => pageListeningLinks(Buffer.from("<script>playAudio()</script>"), "https://example.com")).toThrow();
  replies = [{ headers: { "content-type": "text/html" }, chunks: [html] }];
  const links = await web().fetch("https://example.com/page", "links"); expect(links).toHaveLength(4); expect(mocks.request).toHaveBeenCalledTimes(1);
  replies = [{ chunks: [Buffer.from('<!doctype html><html><audio src="/one.wav"></audio></html>')] }];
  expect(await web().fetch("https://example.com/page", "links")).toEqual([{ url: "https://example.com/one.wav", label: "" }]);
  replies = [{ chunks: [Buffer.from("<ht"), Buffer.from('ml><audio src="/split.wav"></audio></html>')] }];
  expect(await web().fetch("https://example.com/page", "links")).toEqual([{ url: "https://example.com/split.wav", label: "" }]);
});

it("does not read audio bodies while resolving links", async () => {
  replies = [{ headers: { "content-type": "audio/wav" }, chunks: [audio] }];
  expect(await web().fetch("https://example.com/track", "links")).toEqual([{ url: "https://example.com/track", label: "" }]);
});

it.each([["aac", "audio/aac"], ["m4a", "audio/mp4"]])("recognizes %s bytes without trusting the server media type", async (extension, mediaType) => {
  replies = [{ headers: { "content-type": "application/octet-stream" }, chunks: [readFileSync(new URL(`../fixtures/resources/audio/chimes.${extension}`, import.meta.url))] }];
  expect(await web().fetch("https://example.com/track", "audio")).toMatchObject({ mediaType });
});

it("retains a timed-out DNS lookup fence until it returns and then allows explicit retry", async () => {
  let finish!:(value: { address: string; family: number }[]) => void;
  mocks.lookup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(); vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
  const client = web(), pending = client.fetch("https://example.com/one", "audio");
  const rejected = expect(pending).rejects.toMatchObject({ code: "LOCAL_AUDIO_DOWNLOAD_FAILED" });
  await vi.waitFor(() => expect(mocks.lookup).toHaveBeenCalledOnce()); controller.abort(); await rejected;
  await expect(client.fetch("https://example.com/two", "audio")).rejects.toMatchObject({ code: "LOCAL_AUDIO_DOWNLOAD_FAILED" });
  expect(mocks.lookup).toHaveBeenCalledOnce(); expect(mocks.request).not.toHaveBeenCalled();
  finish([{ address: "8.8.8.8", family: 4 }]); await Promise.resolve();
  expect(await client.fetch("https://example.com/three", "audio")).toMatchObject({ mediaType: "audio/wav" });
  expect(mocks.lookup).toHaveBeenCalledTimes(2); expect(mocks.request).toHaveBeenCalledOnce();
});
