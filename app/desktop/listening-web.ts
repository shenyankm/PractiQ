import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { playbackAddress, publicPlaybackHost } from "../../shared/listening.js";
import { AppError, invariant } from "./errors.js";
import { ProviderSlots } from "./provider-slots.js";
import type { DesktopListeningLink } from "../src/contracts.generated.js";

const AUDIO_LIMIT = 25 * 1024 * 1024, PAGE_LIMIT = 2 * 1024 * 1024;
export type ListeningLink = DesktopListeningLink;
const checked = (raw: unknown) => { const value = playbackAddress(raw); invariant(value, "LOCAL_AUDIO_URL_INVALID", "Use a public HTTP or HTTPS playback address"); return new URL(value); };

export function pageListeningLinks(bytes: Uint8Array, address: string): ListeningLink[] {
  invariant(bytes.length <= PAGE_LIMIT, "LOCAL_AUDIO_DOWNLOAD_SIZE", "Audio page exceeds its size limit");
  const document = parse(Buffer.from(bytes).toString("utf8")), nodes: DefaultTreeAdapterMap["element"][] = [];
  const pending: DefaultTreeAdapterMap["node"][] = [document];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node) nodes.push(node);
    if ("childNodes" in node) pending.push(...[...node.childNodes].reverse());
  }
  const attr = (node: DefaultTreeAdapterMap["element"], name: string) => node.attrs.find(attr => attr.name === name)?.value ?? "";
  const base = nodes.find(node => node.tagName === "base" && attr(node, "href"));
  let origin = checked(address);
  if (base) try { origin = checked(new URL(attr(base, "href"), origin).href); } catch { /* Invalid base does not authorize another destination. */ }
  const links: ListeningLink[] = [];
  for (const node of nodes) {
    if (links.length === 50) break;
    const audio = node.tagName === "audio" || node.tagName === "source" && node.parentNode && "tagName" in node.parentNode && node.parentNode.tagName === "audio";
    const meta = node.tagName === "meta" && ["og:audio", "og:audio:url", "og:audio:secure_url"].includes(attr(node, "property"));
    if (!audio && !meta && node.tagName !== "a") continue;
    const raw = attr(node, audio ? "src" : meta ? "content" : "href"); if (!raw.trim()) continue;
    let url: URL; try { url = checked(new URL(raw.trim(), origin).href); } catch { continue; }
    if (node.tagName === "a" && !/\.(mp3|m4a|aac|wav)$/i.test(url.pathname) || links.some(link => link.url === url.href)) continue;
    let label = ""; const text: DefaultTreeAdapterMap["node"][] = [...node.childNodes].reverse();
    while (text.length && label.length < 160) { const child = text.pop()!; if (child.nodeName === "#text" && "value" in child) label += child.value; else if ("childNodes" in child && child.nodeName !== "script" && child.nodeName !== "style") text.push(...[...child.childNodes].reverse()); }
    links.push({ url: url.href, label: [...label.trim()].slice(0, 160).join("") });
  }
  invariant(links.length, "LOCAL_AUDIO_NO_LINKS", "No public audio links were found"); return links;
}

/** No audio bytes are written to storage; callers release the returned memory on unmount. */
export class ListeningWeb {
  private readonly slots = new ProviderSlots();
  private readonly shutdown = new AbortController();
  private resolving?: Promise<unknown>;
  close() { this.shutdown.abort(); }
  private async addresses(host: string, signal: AbortSignal) {
    if (isIP(host)) return [{ address: host, family: isIP(host) }];
    invariant(!this.resolving, "LOCAL_AUDIO_DOWNLOAD_FAILED", "A previous DNS lookup has not finished");
    const pending = lookup(host, { all: true }); this.resolving = pending;
    void pending.then(() => { if (this.resolving === pending) this.resolving = undefined; }, () => { if (this.resolving === pending) this.resolving = undefined; });
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); })]);
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  }
  private async get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
    const host = url.hostname.replace(/^\[|\]$/g, ""), addresses = await this.addresses(host, signal);
    invariant(addresses.length > 0 && addresses.length <= 32 && addresses.every(address => isIP(address.address) && publicPlaybackHost(address.address)), "LOCAL_AUDIO_URL_INVALID", "Audio destination is not public");
    let failed: unknown;
    for (const address of addresses) {
      signal.throwIfAborted();
      try {
        return await new Promise<IncomingMessage>((resolve, reject) => {
          const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
            method: "GET", agent: false, signal, family: address.family,
            lookup: (_host, _options, done) => done(null, address.address, address.family),
            headers: { "Accept-Encoding": "identity", Accept: "audio/*, text/html;q=0.9, */*;q=0.1" },
          }, resolve);
          const connect = setTimeout(() => request.destroy(new AppError("LOCAL_AUDIO_DOWNLOAD_FAILED", "Audio connection timed out")), 10000);
          request.once("response", () => clearTimeout(connect)); request.once("close", () => clearTimeout(connect));
          request.setTimeout(10000, () => request.destroy(new AppError("LOCAL_AUDIO_DOWNLOAD_FAILED", "Audio connection timed out")));
          request.once("error", error => { clearTimeout(connect); reject(error); }); request.end();
        });
      } catch (error) { failed = error; }
    }
    throw failed;
  }
  async fetch(raw: unknown, mode: "links" | "audio"): Promise<ListeningLink[] | { bytes: ArrayBuffer; mediaType: string }> {
    const first = checked(raw), signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(45000)]);
    return this.slots.run(1, signal, async () => {
      try {
        let url = first;
        for (let hop = 0; hop <= 5; hop++) {
          const response = await this.get(url, signal);
          try {
            if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
              invariant(hop < 5 && response.headers.location, "LOCAL_AUDIO_DOWNLOAD_FAILED", "Audio redirect limit exceeded");
              url = checked(new URL(response.headers.location, url).href); continue;
            }
            invariant(response.statusCode === 200 && (!response.headers["content-encoding"] || response.headers["content-encoding"] === "identity"), "LOCAL_AUDIO_DOWNLOAD_FAILED", "Audio response is unavailable");
            const media = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase(); let html = ["text/html", "application/xhtml+xml"].includes(media);
            if (mode === "links" && media.startsWith("audio/")) return [{ url: url.href, label: "" }];
            invariant(mode === "links" || !html, "LOCAL_AUDIO_NO_LINKS", "Choose an audio playback address from this page first");
            let limit = html ? PAGE_LIMIT : AUDIO_LIMIT; const declared = response.headers["content-length"];
            invariant(declared === undefined || /^\d+$/.test(declared) && Number(declared) <= limit, "LOCAL_AUDIO_DOWNLOAD_SIZE", "Audio response exceeds its size limit");
            let size = 0; const chunks: Buffer[] = [];
            for await (const chunk of response) {
              signal.throwIfAborted(); const bytes = Buffer.from(chunk);
              size += bytes.length; chunks.push(bytes);
              if (mode === "links" && !html) {
                const prefix = Buffer.concat(chunks, Math.min(size, 256)).toString("utf8").trimStart().toLowerCase();
                html = prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
                if (!html && size >= 256) return [{ url: url.href, label: "" }];
                if (html) { limit = PAGE_LIMIT; invariant(declared === undefined || Number(declared) <= limit, "LOCAL_AUDIO_DOWNLOAD_SIZE", "Audio page exceeds its size limit"); }
              }
              invariant(size <= limit, "LOCAL_AUDIO_DOWNLOAD_SIZE", "Audio response exceeds its size limit");
            }
            if (mode === "links" && !html) return [{ url: url.href, label: "" }];
            const bytes = Buffer.concat(chunks); signal.throwIfAborted();
            if (html) return pageListeningLinks(bytes, url.href);
            const framed = bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0;
            const type = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE" ? "audio/wav" : bytes.subarray(4, 8).toString() === "ftyp" ? "audio/mp4" : framed && (bytes[1] & 0xf6) === 0xf0 ? "audio/aac" : bytes.subarray(0, 3).toString() === "ID3" || framed ? "audio/mpeg" : "";
            invariant(type && bytes.length > 12, "LOCAL_AUDIO_INVALID", "Use MP3, M4A/AAC or WAV audio");
            return { bytes: Uint8Array.from(bytes).buffer, mediaType: type };
          } finally { response.destroy(); }
        }
        throw new AppError("LOCAL_AUDIO_DOWNLOAD_FAILED", "Audio redirect limit exceeded");
      } catch (error) { if (error instanceof AppError) throw error; throw new AppError("LOCAL_AUDIO_DOWNLOAD_FAILED", "Audio loading failed"); }
    });
  }
}
