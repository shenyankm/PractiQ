import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export const MAIN_LOG_LIMIT = 256 * 1024;
const MAX_LINE = 2048;

/** Replaces the local profile location so a shared log never reveals where the app stores data. */
export function redactPath(text: string, home = homedir()): string {
  return home && home !== "/" ? text.split(home).join("~") : text;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = typeof (error as Error & { code?: unknown }).code === "string" ? `[${(error as Error & { code: string }).code}] ` : "";
    const frames = (error.stack ?? "").split("\n").slice(1, 6).map(line => line.trim()).filter(Boolean).join(" | ");
    return `${code}${error.message}${frames ? ` @@ ${frames}` : ""}`;
  }
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? String(error); } catch { return "Unserializable value"; }
}

/** A bounded, self-rotating main-process log. Recording never throws or replaces the reported failure. */
export class MainLog {
  constructor(readonly file: string, readonly limit = MAIN_LOG_LIMIT) {}
  record(scope: string, error: unknown): string {
    const line = `${new Date().toISOString()} ${scope.replace(/[^\w.:-]+/g, "_").slice(0, 48)} ${redactPath(describeError(error)).replace(/[\r\n\t]+/g, " ").slice(0, MAX_LINE)}\n`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      // Rotation keeps repeated failures from filling the disk; retained history is one older file.
      if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) + line.length > this.limit) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, line, { mode: 0o600 });
    } catch { /* The original failure is still returned to its caller. */ }
    return line;
  }
}
