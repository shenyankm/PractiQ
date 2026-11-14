import type { ContentBlock } from "../app/src/contracts.generated.js";

export const LISTENING_ADDRESS_ROLE = "listening_audio_url";

export function publicPlaybackHost(host: string): boolean {
  host = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host.includes(":")) {
    const [first, second] = host.split(":").map(value => parseInt(value || "0", 16));
    return (first & 0xe000) === 0x2000 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x2002 && !(first === 0x3fff && second < 0x1000);
  }
  if (/^[\d.]+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  return host.includes(".") && !["localhost", "local", "internal", "onion"].some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

export function playbackAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port && !["80", "443"].includes(url.port) || !publicPlaybackHost(url.hostname)) return null;
    url.hash = ""; return url.href.length <= 8192 ? url.href : null;
  } catch { return null; }
}

export function listeningAddress(question: { contentBlocks?: ContentBlock[] }): string | null {
  const block = question.contentBlocks?.find(block => block.role === LISTENING_ADDRESS_ROLE);
  return playbackAddress(block?.textValue);
}

export function listeningBlocks(blocks: ContentBlock[], address: string | null): ContentBlock[] {
  const retained = blocks.filter(block => block.role !== LISTENING_ADDRESS_ROLE);
  return address ? [...retained, { partType: "text", role: LISTENING_ADDRESS_ROLE, textValue: address }] : retained;
}
