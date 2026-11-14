import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GradingResponse, QuestionRow } from "../src/api.js";
import { Assets, hash } from "./assets.js";
import { transaction } from "./database.js";
import { invariant } from "./errors.js";
import { sourceMaximum, verifyGradeEvidence } from "./grading-result.js";
import { object, text } from "./question-contract.js";
import { canonical, QuestionIndex, thaw } from "./questions.js";
import { hasBasis, Sessions, usable, type SessionWire } from "./sessions.js";

export interface GradeTarget { kind: "electron"; endpoint: string; modelId: string; promptVersion: string }
export interface GradePayload { question: QuestionRow["question"]; answer: string; maxCents: number; materials: string[]; images: { sha256: string; data: string }[]; feedbackLocale: string }
export interface PreparedGrade { requestId: string; inputDigest: string; payload: string; generation: string; previous?: GradingResponse }
export const unknownGrade = (): GradingResponse => ({ status: "unknown", appError: { code: "LOCAL_MODEL_RESULT_UNKNOWN", message: "Result unknown; explicitly regrade after checking the record" } });

/** A new instance after restore fences replies from the previous database generation. */
export class Grading {
  private readonly generation = randomUUID();
  constructor(readonly db: DatabaseSync, readonly assets: Assets, readonly sessions: Sessions) {}
  prepare(id: string, ordinal: number, retry: boolean, locale: string, target: GradeTarget): PreparedGrade {
    invariant(Number.isSafeInteger(ordinal) && ordinal >= 0 && ["zh-CN", "zh-TW", "en"].includes(locale), "LOCAL_FILTER_INVALID", "Invalid grading request");
    this.sessions.session(id);
    return transaction(this.db, () => {
      const attempt = this.db.prepare("SELECT a.snapshot_question_id,a.answer,a.max_cents,CASE WHEN s.kind='practice' THEN a.submitted_at ELSE s.submitted_at END AS submitted,a.grade_kind,a.skipped FROM attempts a JOIN sessions s ON s.id=a.session_id WHERE a.session_id=? AND a.ordinal=?").get(id, ordinal);
      invariant(attempt, "LOCAL_GRADING_INELIGIBLE", "This answer cannot be graded");
      const snapshot = new QuestionIndex(thaw(this.sessions.document(id))).snapshot(String(attempt.snapshot_question_id)), question = snapshot.question, answer: unknown = JSON.parse(String(attempt.answer));
      this.assets.markMissing([snapshot as unknown as Record<string, unknown>]);
      invariant(attempt.submitted !== null && !attempt.skipped && !["manual", "self"].includes(String(attempt.grade_kind)) && question.answerMode === "short_answer" && hasBasis(question) && usable(snapshot) && text(answer, "text").trim(), "LOCAL_GRADING_INELIGIBLE", "A submitted subjective answer and complete grading evidence are required");
      const images: GradePayload["images"] = [], seen = new Set<string>();
      for (const visual of snapshot.visuals) {
        const digest = visual.imageRef?.sha256;
        if (!digest || seen.has(digest)) continue;
        seen.add(digest); const asset = this.assets.bytes(digest);
        invariant(asset && ["image/png", "image/jpeg"].includes(asset.media), "LOCAL_GRADING_IMAGE_MISSING", "Grading image is missing");
        invariant(asset.bytes.length <= 20 * 1024 * 1024, "LOCAL_GRADING_TOO_LARGE", "Grading image exceeds its limit");
        images.push({ sha256: digest, data: `data:${asset.media};base64,${asset.bytes.toString("base64")}` });
      }
      const materials = [...snapshot.groups.map(group => `${group.title ?? ""}\n${group.instructions ?? ""}${object(group).contentBlocks === undefined ? "" : `\n${canonical(object(group).contentBlocks)}`}`), ...(snapshot.materials ?? []).map(material => canonical(material)), ...snapshot.visuals.map(visual => `${visual.description ?? ""}\n${visual.extractedText ?? ""}`)];
      invariant([...text(answer, "text")].length <= 120000 && materials.length <= 100 && materials.reduce((sum, material) => sum + [...material].length, 0) <= 120000 && images.length <= 32, "LOCAL_GRADING_TOO_LARGE", "Grading input exceeds its limit");
      const payload: GradePayload = { question, answer: text(answer, "text"), maxCents: attempt.max_cents === null ? sourceMaximum(question, 10000) : Number(attempt.max_cents), materials, images, feedbackLocale: locale };
      if (!retry) {
        const row = this.db.prepare("SELECT id,input,response FROM grade_requests WHERE session_id=? AND ordinal=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id, ordinal);
        if (row) {
          const previous = object(JSON.parse(String(row.input)));
          invariant(canonical(previous.target) === canonical(target), "LOCAL_GRADING_TARGET_CHANGED", "Grading target changed; explicitly regrade to use the new target");
          invariant(["zh-CN", "zh-TW", "en"].includes(text(previous, "feedbackLocale")), "LOCAL_GRADING_INPUT_CHANGED", "Saved grading input has no supported feedback language");
          payload.feedbackLocale = String(previous.feedbackLocale); const raw = canonical(payload);
          invariant(previous.inputDigest === hash(raw), "LOCAL_GRADING_INPUT_CHANGED", "Saved grading input differs from the frozen answer");
          return { requestId: String(row.id), inputDigest: hash(raw), payload: raw, generation: this.generation, previous: row.response === null ? unknownGrade() : JSON.parse(String(row.response)) as GradingResponse };
        }
      }
      const raw = canonical(payload); invariant(Buffer.byteLength(raw) <= 31 * 1024 * 1024, "LOCAL_GRADING_TOO_LARGE", "Grading input exceeds its byte limit");
      const requestId = randomUUID(), inputDigest = hash(raw), response = unknownGrade();
      this.db.prepare("INSERT INTO grade_requests VALUES(?,?,?,?,?,?)").run(requestId, id, ordinal, canonical({ requestId, inputDigest, feedbackLocale: locale, target }), canonical(response), this.sessions.now());
      this.db.prepare("UPDATE attempts SET grading=json_set(grading,'$.lastRequest',json(?)) WHERE session_id=? AND ordinal=?").run(canonical(response), id, ordinal);
      return { requestId, inputDigest, payload: raw, generation: this.generation };
    });
  }
  record(id: string, ordinal: number, prepared: PreparedGrade, response: GradingResponse, snapshotKey?: string): SessionWire {
    invariant(prepared.generation === this.generation, "LOCAL_GRADING_REQUEST_MISSING", "The database was reopened; this grading result cannot be applied");
    transaction(this.db, () => {
      const request = this.db.prepare("SELECT input FROM grade_requests WHERE id=? AND session_id=? AND ordinal=?").get(prepared.requestId, id, ordinal);
      invariant(request && object(JSON.parse(String(request.input))).inputDigest === prepared.inputDigest && hash(prepared.payload) === prepared.inputDigest, "LOCAL_GRADING_REQUEST_MISSING", "Grading receipt is missing or its input changed");
      invariant(["graded", "ungraded", "unknown"].includes(response.status) && Buffer.byteLength(JSON.stringify(response)) <= 4 * 1024 * 1024, "LOCAL_RESPONSE_INVALID", "Invalid grading response");
      const payload = JSON.parse(prepared.payload) as GradePayload;
      if (response.result) { verifyGradeEvidence(response.result, payload.question, payload.answer); invariant(response.result.maxCents === payload.maxCents, "LOCAL_AI_MAX_MISMATCH", "Grading maximum differs from the session maximum"); }
      const score = response.status === "graded" ? response.result?.scoreCents : null;
      invariant(response.status !== "graded" || Number.isSafeInteger(score) && Number(score) >= 0 && Number(score) <= payload.maxCents, "LOCAL_AI_SCORE_INVALID", "Invalid AI score");
      const raw = canonical(response);
      this.db.prepare("UPDATE grade_requests SET response=? WHERE id=?").run(raw, prepared.requestId);
      this.db.prepare("UPDATE attempts SET grading=json_set(CASE WHEN ?4 IS NULL THEN grading ELSE json_remove(grading,'$.lastRequest') END,CASE WHEN ?4 IS NULL THEN '$.lastRequest' ELSE '$.ai' END,json(?3)),max_cents=CASE WHEN grade_kind IN ('manual','self') OR ?4 IS NULL THEN max_cents ELSE ?6 END,earned_cents=CASE WHEN grade_kind IN ('manual','self') OR ?4 IS NULL THEN earned_cents ELSE ?4 END,result=CASE WHEN grade_kind IN ('manual','self') OR ?4 IS NULL THEN result ELSE (?4=?6) END,grade_kind=CASE WHEN grade_kind IN ('manual','self') OR ?4 IS NULL THEN grade_kind ELSE 'ai' END WHERE session_id=?1 AND ordinal=?2 AND ?5=(SELECT id FROM grade_requests WHERE session_id=?1 AND ordinal=?2 ORDER BY created_at DESC,rowid DESC LIMIT 1)").run(id, ordinal, raw, score ?? null, prepared.requestId, payload.maxCents);
    });
    return this.sessions.session(id, snapshotKey);
  }
}
