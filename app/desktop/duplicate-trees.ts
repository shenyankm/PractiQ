import { createHash } from "node:crypto";
import type { ParsedGroup, Question, VisualElement } from "../src/contracts.generated.js";
import { invariant } from "./errors.js";
import type { MergeQuality, MergeSource } from "./merge-chunks.js";
import { parsedQuestionDefaults } from "./model-defaults.js";
import { validateParsedTree } from "./question-contract.js";
import { canonical } from "./questions.js";
import type { SourceEvidence } from "./source-evidence.js";
import { SOURCE_WHITESPACE, sourceTrim } from "./source-text.js";

type Candidates = string[][][];
type Evidence = Record<string, SourceEvidence | null>;
function digest(value: unknown): string {
  const pending = [value]; while (pending.length) { const item = pending.pop(); invariant(typeof item !== "number" || Number.isFinite(item), "OUTPUT_INVALID", "Nonfinite source evidence"); if (item !== null && typeof item === "object") for (const child of Object.values(item)) pending.push(child); }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function wholeTrees(questions: Question[]): number[][] {
  validateParsedTree(questions); const byId = new Map(questions.map((question, index) => [question.id, index])), trees = new Map<number, number[]>();
  for (const [index] of questions.entries()) { let root = index; while (questions[root].parentId) root = byId.get(questions[root].parentId)!; trees.set(root, [...trees.get(root) ?? [], index]); }
  return [...trees.values()];
}
const candidates = (questions: Question[], seen: Map<string, number[][]>): Candidates => [...seen.values()].filter(copies => copies.length > 1).map(copies => copies.map(indexes => indexes.map(index => questions[index].id!)));

/** Original-source repeats remain review candidates even when model fields differ. */
export function findSourceDuplicateTrees(questions: Question[], evidence: Evidence = {}): Candidates {
  const seen = new Map<string, number[][]>();
  for (const indexes of wholeTrees(questions)) {
    const proofs = indexes.map(index => evidence[questions[index].id!]); if (!proofs.every(proof => proof?.full_source && (typeof proof.full_source !== "object" || Object.keys(proof.full_source).length))) continue;
    const key = digest(proofs.map(proof => proof!.full_source)); seen.set(key, [...seen.get(key) ?? [], indexes]);
  }
  return candidates(questions, seen);
}

/** Discover exact copies without changing questions, review metadata or associations. */
export function findDuplicateTrees(questions: Question[], groups: ParsedGroup[], visuals: VisualElement[], evidence: Evidence = {}): Candidates {
  const trees = wholeTrees(questions), byQuestion = new Map(trees.flatMap((indexes, tree) => indexes.map(index => [index, tree] as const))), excluded = new Set<number>(), groupsByQuestion = new Map<number, ParsedGroup[]>(), visualsByQuestion = new Map<number, VisualElement[]>();
  for (const group of groups) {
    const members = new Set(group.questionIndexes), owners = new Set([...members].map(index => byQuestion.get(index)));
    if (owners.size > 1 || owners.has(undefined)) { for (const owner of owners) if (owner !== undefined) excluded.add(owner); if (excluded.size === trees.length) return []; continue; }
    for (const index of members) groupsByQuestion.set(index, [...groupsByQuestion.get(index) ?? [], group]);
  }
  for (const visual of visuals) for (const index of new Set(visual.questionIndexes)) visualsByQuestion.set(index, [...visualsByQuestion.get(index) ?? [], visual]);
  const seen = new Map<string, number[][]>();
  for (const [tree, indexes] of trees.entries()) {
    if (excluded.has(tree)) continue; const localIndexes = new Map(indexes.map((index, local) => [index, local])), ids = new Map(indexes.map((index, local) => [questions[index].id, local]));
    let proofs = indexes.map(index => evidence[questions[index].id!]); if (indexes.some(index => Object.hasOwn(evidence, questions[index].id!))) { if (!proofs.every(Boolean)) continue; } else proofs = [];
    const nodes = indexes.map((index, local) => {
      const question = questions[index], node = parsedQuestionDefaults(question);
      for (const field of ["id", "confidence", "needsReview", "missingFields"]) delete node[field];
      const quote = (question.sourceText ?? "").replace(new RegExp(`^${SOURCE_WHITESPACE}*\\p{Nd}{1,4}${SOURCE_WHITESPACE}*[.、)．]${SOURCE_WHITESPACE}*`, "u"), ""); node.sourceText = sourceTrim(quote.replace(new RegExp(`${SOURCE_WHITESPACE}+`, "gu"), " "));
      if (proofs.length) { node.sourceText = proofs[local]!.canonical_quote; node.verifiedSource = proofs[local]!.full_source; }
      for (const field of ["parentId", "optionSourceId"]) node[field] = node[field] ? ids.get(node[field] as string) ?? null : null;
      node.passage = (node.passage as Record<string, unknown>[]).map(block => block.questionId ? { ...block, questionId: ids.get(block.questionId as string) } : block);
      node.groupEvidence = (groupsByQuestion.get(index) ?? []).map(group => [group.title, group.instructions ?? null, group.questionIndexes.map(member => localIndexes.get(member))]).sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
      node.visuals = (visualsByQuestion.get(index) ?? []).map(visual => ({ kind: visual.kind, role: visual.role, label: visual.label ?? null, description: visual.description ?? null, extractedText: visual.extractedText ?? null, imageSha256: visual.imageRef?.sha256 ?? null, sourceSha256: visual.sourceRef?.sha256 ?? null, sourceBbox: visual.imageRef == null ? visual.bbox ?? null : null }));
      return node;
    });
    const key = digest(nodes); if (nodes.every(node => node.sourceText && (typeof node.sourceText !== "object" || Object.keys(node.sourceText).length))) seen.set(key, [...seen.get(key) ?? [], indexes]);
  }
  return candidates(questions, seen);
}

/** Apply only previously proven complete copies after the explicit opt-in. */
export function removeDuplicateTrees(questions: Question[], groups: ParsedGroup[], visuals: VisualElement[], sources: MergeSource[], quality: MergeQuality, copies: Candidates): [Question[], string[]] {
  const aliases = new Map<string, string>(); for (const trees of copies) for (const copy of trees.slice(1)) { invariant(copy.length === trees[0].length, "OUTPUT_INVALID", "Duplicate trees differ in size"); copy.forEach((id, index) => aliases.set(id, trees[0][index])); }
  if (!aliases.size) return [questions, []];
  const byId = new Map(questions.map(question => [question.id, question]));
  for (const [duplicate, first] of aliases) {
    const retained = byId.get(first), removed = byId.get(duplicate); invariant(retained && removed && !aliases.has(first), "OUTPUT_INVALID", "Invalid duplicate aliases");
    retained.needsReview ||= removed.needsReview; retained.confidence = Math.min(retained.confidence, removed.confidence); retained.missingFields = [...new Set([...retained.missingFields, ...removed.missingFields])];
  }
  const retained = questions.filter(question => !aliases.has(question.id!)), finalIndexes = new Map(retained.map((question, index) => [question.id!, index])), indexMap = questions.map(question => finalIndexes.get(aliases.get(question.id!) ?? question.id!)!);
  groups.splice(0, groups.length, ...groups.filter(group => !group.questionIndexes.length || group.questionIndexes.some(index => !aliases.has(questions[index].id!))));
  for (const group of groups) group.questionIndexes = group.questionIndexes.filter(index => !aliases.has(questions[index].id!)).map(index => indexMap[index]);
  for (const visual of visuals) visual.questionIndexes = [...new Set((visual.questionIndexes ?? []).map(index => indexMap[index]))];
  for (const source of sources) source.questionIndex = indexMap[source.questionIndex]; const uniqueSources = new Map(sources.map(source => [`${source.questionIndex}:${source.stage}:${source.unitIndex}`, source])); sources.splice(0, sources.length, ...uniqueSources.values());
  quality.issues = [...new Map(quality.issues.map(issue => { const mapped = { ...issue, questionIndex: indexMap[issue.questionIndex] }; return [`${mapped.questionIndex}:${mapped.code}`, mapped] as const; })).values()].sort((a, b) => a.questionIndex - b.questionIndex || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const validated = validateParsedTree(retained); for (const [index, question] of retained.entries()) { question.needsReview = validated[index].needsReview; question.missingFields = validated[index].missingFields; question.answerPayload = validated[index].answerPayload; }
  quality.reviewQuestionCount = retained.filter(question => question.needsReview).length; quality.reviewRequired = Boolean(quality.reviewQuestionCount);
  return [retained, [`Removed ${aliases.size} exact duplicate question nodes after explicit opt-in; retained their source associations.`]];
}
