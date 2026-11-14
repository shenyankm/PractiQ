import type { PageFigure, ParsedGroup, Question } from "../src/contracts.generated.js";
import { invariant } from "./errors.js";
import { modelDefaults, parsedQuestionDefaults } from "./model-defaults.js";
import { isAnswerRole, validatePageFigure } from "./page-figures.js";
import { composite, object } from "./question-contract.js";
import { canonical } from "./questions.js";
import { validateSourceFields, type SourceFieldContext } from "./source-fields.js";

export interface ParsedPage { questions: Question[]; groups: ParsedGroup[]; figures: PageFigure[]; figureIds?: number[] }
const sameSet = <T>(a: Set<T>, b: Set<T>): boolean => a.size === b.size && [...a].every(item => b.has(item));
const containsInOrder = (added: unknown[], original: unknown[], model?: string): boolean => {
  let index = 0; for (const item of original) { const key = canonical(model ? modelDefaults(model, item) : item); while (index < added.length && canonical(model ? modelDefaults(model, added[index]) : added[index]) !== key) index++; if (index === added.length) return false; index++; } return true;
};

/** Context can add evidence but cannot replace PRIMARY identities, material or figure payloads. */
export function validatePageResult(input: unknown, scope: SourceFieldContext, primary?: ParsedPage, figureIds?: number[]): ParsedPage {
  const value = object(structuredClone(input)); invariant(input !== null && typeof input === "object" && !Array.isArray(input) && Object.keys(value).every(key => ["questions", "groups", "figures"].includes(key)), "UNIT_RESULT_INVALID", "Invalid page result");
  for (const key of ["questions", "groups", "figures"]) value[key] ??= [];
  if (Array.isArray(value.questions)) for (const raw of value.questions) {
    const question = object(raw); if (!Array.isArray(question.contentBlocks)) continue;
    const kept = question.contentBlocks.filter(block => block === null || typeof block !== "object" || Array.isArray(block) || ["textValue", "markdownValue", "latexValue"].some(key => Boolean(object(block)[key])) || object(block).jsonValue != null);
    if (kept.length !== question.contentBlocks.length) { question.contentBlocks = kept; question.needsReview = true; question.missingFields = [...new Set([...(Array.isArray(question.missingFields) ? question.missingFields : []), "material"])]; }
  }
  invariant(Array.isArray(value.figures) && value.figures.length <= 1000, "UNIT_RESULT_INVALID", "Invalid page figure list");
  if (Array.isArray(value.questions) && !value.questions.length) for (const figure of value.figures) if (figure !== null && typeof figure === "object" && !Array.isArray(figure)) object(figure).questionIndexes = [];
  const parsed = validateSourceFields({ questions: value.questions, groups: value.groups }, scope), figures = value.figures.map(validatePageFigure);
  parsed.questions = parsed.questions.map(question => parsedQuestionDefaults(question) as unknown as Question); parsed.groups = parsed.groups.map(group => modelDefaults("ParsedGroup", group) as unknown as ParsedGroup);
  const page: ParsedPage = { ...parsed, figures, ...(figureIds ? { figureIds: [...figureIds] } : {}) };
  invariant(figures.every(figure => (figure.questionIndexes ?? []).every(index => Number.isSafeInteger(index) && index >= 0 && index < parsed.questions.length)), "UNIT_RESULT_INVALID", "Figure associations must reference this page response");
  invariant(figureIds === undefined || figureIds.length === figures.length && new Set(figureIds).size === figureIds.length && figureIds.every(id => Number.isSafeInteger(id) && id >= 0), "UNIT_RESULT_INVALID", "Invalid fixed figure identities");
  if (!primary) return page;
  const require = (condition: unknown, detail: string) => invariant(condition, "UNIT_RESULT_INVALID", `Context enrichment must preserve PRIMARY ${detail}`), ordinary = parsed.questions.filter(question => !composite(question)), expected = new Set(primary.questions.filter(question => question.id != null && !composite(question)).map(question => question.id));
  require(ordinary.length === expected.size && sameSet(new Set(ordinary.map(question => question.id)), expected), "ordinary question IDs exactly; never add, remove or relabel a context question");
  for (const question of primary.questions) {
    const candidate = parsed.questions.find(item => item.id === question.id); require(candidate && (!composite(question) || candidate.answerMode === question.answerMode), "composite records and answer modes");
    for (const [field, model] of (composite(question) ? [["passage", "ContentBlock"], ["options", "ParsedOption"], ["contentBlocks", "ContentBlock"], ["transcript", "ContentBlock"]] : [["contentBlocks", "ContentBlock"]])) require(containsInOrder((candidate as unknown as Record<string, unknown[]>)[field] ?? [], (question as unknown as Record<string, unknown[]>)[field] ?? [], model), `${field} items verbatim and in order; append context as new items`);
  }
  const owners = (questions: Question[], indexes: number[]) => new Set(indexes.map(index => questions[index].id)), groups = [...parsed.groups];
  for (const group of primary.groups) {
    const index = groups.findIndex(candidate => candidate.title === group.title && (group.instructions == null || candidate.instructions === group.instructions) && sameSet(owners(primary.questions, group.questionIndexes), owners(parsed.questions, candidate.questionIndexes)));
    require(index >= 0, "groups with their titles, instructions and question associations"); groups.splice(index, 1);
  }
  require(groups.every(group => group.questionIndexes.length), "unassociated groups; never add an empty context-only group");
  const remaining = figures.map((figure, index) => ({ figure, index }));
  for (const [sourceIndex, figure] of primary.figures.entries()) {
    const index = remaining.findIndex(candidate => (primary.figureIds === undefined || figureIds !== undefined && figureIds[candidate.index] === primary.figureIds[sourceIndex]) && candidate.figure.kind === figure.kind && canonical(candidate.figure.bbox) === canonical(figure.bbox) && sameSet(owners(primary.questions, figure.questionIndexes ?? []), owners(parsed.questions, candidate.figure.questionIndexes ?? [])));
    require(index >= 0, "figures with their fixed IDs, kind, bounds and question associations"); const candidate = remaining[index].figure;
    require((figure.tableRows == null || containsInOrder(candidate.tableRows ?? [], figure.tableRows)) && (!figure.extractedText || candidate.extractedText?.includes(figure.extractedText)) && (!isAnswerRole(figure.role) || isAnswerRole(candidate.role)) && (figure.label == null || candidate.label === figure.label), "figure payload: original rows/cells in order, extracted text, printed label and answer-bearing role"); remaining.splice(index, 1);
  }
  return page;
}
