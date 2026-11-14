import sharp from "sharp";
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, closeSync, fstatSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ASSET_LIMIT } from "./assets.js";
import { AppError, invariant } from "./errors.js";
import { object } from "./question-contract.js";

export async function validateImage(bytes: Uint8Array, media: string): Promise<void> {
  invariant(bytes.byteLength > 0 && bytes.byteLength <= ASSET_LIMIT && ["image/png", "image/jpeg"].includes(media), "LOCAL_BACKUP_RESOURCE_INVALID", "Invalid image format or size");
  const signature = Buffer.from(bytes.subarray(0, 8));
  invariant(media === "image/png" ? signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : signature[0] === 255 && signature[1] === 216 && signature[2] === 255, "LOCAL_BACKUP_RESOURCE_INVALID", "Invalid image signature");
  const image = sharp(bytes, { limitInputPixels: 32000000, failOn: "warning" }).timeout({ seconds: 5 });
  try {
    const metadata = await image.metadata(), width = metadata.width ?? 0, height = metadata.height ?? 0;
    const sampleBytes = ({ uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4, double: 8 } as Record<string, number>)[metadata.depth] ?? 1;
    invariant(metadata.format === (media === "image/png" ? "png" : "jpeg") && width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 32000000 && width * height * metadata.channels * sampleBytes <= 128 * 1024 * 1024, "LOCAL_BACKUP_RESOURCE_INVALID", "Invalid image dimensions or decoded size");
    await image.stats();
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError("LOCAL_BACKUP_RESOURCE_INVALID", "Image decoding failed"); }
  finally { image.destroy(); }
}

function run(directory: string, executable: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const profile = `(version 1)(allow default)(deny network*)(deny file-read*)(deny file-write*)
      (allow file-read-metadata)
      (allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/usr/bin") (subpath "/bin") (subpath "/Library/Apple") (subpath "/dev") (subpath ${JSON.stringify(directory)}))
      (allow file-write* (subpath ${JSON.stringify(directory)}) (literal "/dev/null"))`;
    const process = spawn("/usr/bin/sandbox-exec", ["-p", profile, executable, ...args], { stdio: ["ignore", "pipe", "pipe"], timeout: Math.max(1, timeout), killSignal: "SIGKILL", env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: directory } });
    let output = "", size = 0, errorSize = 0, failed = false;
    process.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) { failed = true; process.kill("SIGKILL"); } else output += chunk.toString("utf8"); });
    process.stderr.on("data", (chunk: Buffer) => { errorSize += chunk.length; if (errorSize > 8192) { failed = true; process.kill("SIGKILL"); } });
    process.on("error", () => reject(new AppError("LOCAL_AUDIO_INVALID", "Audio validation could not start")));
    process.on("close", (code, signal) => { if (code !== 0 || signal || failed) reject(new AppError("LOCAL_AUDIO_INVALID", "Audio decoding failed or exceeded its time limit")); else resolve(output); });
  });
}
/** macOS CoreAudio decodes to bounded temporary PCM; no extra codec runtime is shipped. */
export async function audioInfo(bytes: Uint8Array): Promise<{ media: string; duration: number }> {
  invariant(process.platform === "darwin", "LOCAL_AUDIO_INVALID", "Native audio validation requires macOS");
  invariant(bytes.byteLength > 0 && bytes.byteLength <= ASSET_LIMIT, "LOCAL_AUDIO_INVALID", "Invalid audio size");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "practiq-audio-"))), source = join(directory, "source"), output = join(directory, "decoded.wav"), deadline = Date.now() + 5000;
  try {
    writeFileSync(source, bytes, { flag: "wx", mode: 0o600 });
    const info = await run(directory, "/usr/bin/afinfo", ["-r", "-x", source], deadline - Date.now());
    const estimated = Number(/<duration units="sec">([^<]*)<\/duration>/.exec(info)?.[1]);
    invariant(Number.isFinite(estimated) && estimated > 0 && estimated <= 86400, "LOCAL_AUDIO_INVALID", "Invalid audio duration");
    const buffer = Buffer.from(bytes), codec = /<format_type>([^<]*)<\/format_type>/.exec(info)?.[1].trim() ?? "";
    const media = buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WAVE" ? "audio/wav" : buffer.subarray(4, 8).toString() === "ftyp" ? "audio/mp4" : codec === ".mp3" ? "audio/mpeg" : ["aac", "aach", "aacp"].includes(codec) ? "audio/aac" : "";
    invariant(media, "LOCAL_AUDIO_INVALID", "Use MP3, M4A/AAC or WAV audio");
    // A fixed shell fragment sets limits before exec; all paths are separate positional arguments.
    await run(directory, "/bin/sh", ["-c", 'ulimit -f 1500000; ulimit -t 5; exec /usr/bin/afconvert "$@"', "practiq-audio", "-f", "WAVE", "-d", "UI8@8000", "-c", "1", source, output], deadline - Date.now());
    const fd = openSync(output, "r");
    let duration = 0;
    try {
      const stat = fstatSync(fd), header = Buffer.alloc(12);
      invariant(stat.isFile() && stat.size <= 700 * 1024 * 1024 && readSync(fd, header, 0, 12, 0) === 12 && header.subarray(0, 4).toString() === "RIFF" && header.subarray(8).toString() === "WAVE", "LOCAL_AUDIO_INVALID", "Invalid decoded audio");
      let offset = 12, byteRate = 0, dataSize = 0;
      while (offset + 8 <= stat.size) {
        const chunk = Buffer.alloc(8); invariant(readSync(fd, chunk, 0, 8, offset) === 8, "LOCAL_AUDIO_INVALID", "Truncated decoded audio");
        const name = chunk.subarray(0, 4).toString(), size = chunk.readUInt32LE(4); offset += 8;
        invariant(offset + size <= stat.size, "LOCAL_AUDIO_INVALID", "Truncated decoded audio");
        if (name === "fmt ") { const format = Buffer.alloc(16); invariant(size >= 16 && readSync(fd, format, 0, 16, offset) === 16, "LOCAL_AUDIO_INVALID", "Invalid PCM audio"); byteRate = format.readUInt32LE(8); }
        if (name === "data") dataSize += size;
        offset += size + size % 2;
      }
      duration = byteRate > 0 ? dataSize / byteRate : 0;
    } finally { closeSync(fd); }
    invariant(Number.isFinite(duration) && duration > 0 && duration <= 86400, "LOCAL_AUDIO_INVALID", "Invalid audio duration");
    return { media, duration };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
export async function mediaDuration(bytes: Uint8Array, media: string): Promise<number | null> {
  if (media.startsWith("image/")) { await validateImage(bytes, media); return null; }
  const result = await audioInfo(bytes);
  invariant(result.media === media, "LOCAL_BACKUP_RESOURCE_INVALID", "Audio content does not match its declared type"); return result.duration;
}
export function validateSegment(question: unknown, duration: number): void {
  const q = object(question);
  invariant(Number(q.audioStartSeconds ?? 0) < duration && (q.audioEndSeconds == null || Number(q.audioEndSeconds) <= duration + 0.05), "LOCAL_AUDIO_INVALID", "Audio segment exceeds file duration");
}
