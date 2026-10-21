import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));
const rich = fixture('rich-content/expected');
export const layoutImage = readFileSync(new URL(`../fixtures/rich-content/resources/${rich.visualElements[0].imageRef.objectKey}`, import.meta.url));
const portrait = readFileSync(new URL('../fixtures/ai-import/formats/resources/preview.png', import.meta.url));
const audio = readFileSync(new URL('../fixtures/resources/audio/chimes.wav', import.meta.url));
export const layoutViewports = [[390,844], [1280,720]];

const selected = new Map();
for (const source of ['sample', 'english', 'composite'].map(fixture)) {
  for (const q of source.questions) {
    if (['reading','word_bank','cloze','listening','gap_fill'].includes(q.answerMode)) continue;
    const parent = source.questions.find(p => p.id === q.parentId);
    const key = q.questionKind || parent?.questionKind || parent?.answerMode || (q.answerMode === 'choice' ? q.choiceVariant : q.answerMode === 'matching' ? q.matchingVariant : q.answerMode) || 'unknown';
    if (selected.has(key)) continue;
    const question = structuredClone(q);
    const owner = source.questions.find(p => p.id === q.optionSourceId);
    if (owner) question.options = structuredClone(owner.options);
    selected.set(key, { key, question, materials: parent ? [parent] : [], groups: [], visuals: [], sources: [], warnings: [], missingAssets: false });
  }
}
const stressed = structuredClone(selected.get('single'));
stressed.key = 'rich-choice';
stressed.question.stem = rich.questions[0].stem;
stressed.question.contentBlocks = rich.questions[0].contentBlocks;
stressed.question.options[0].content = 'Matrix option:\n\n$$\\displaystyle \\frac{\\sum_{n=1}^{\\infty}\\frac{(-1)^{n+1}}{n^2}}{\\sqrt{1+\\frac{x^2}{1+x^2}}}+\\int_0^1\\frac{x^2}{\\sqrt{1-x^2}}\\,dx=\\frac{\\pi}{4}$$';
stressed.visuals = [{ ...rich.visualElements[0], id: 'rich-visual', questionIds: [stressed.question.id], sourceRef: { objectKey: 'portrait.png', sha256: createHash('sha256').update(portrait).digest('hex'), mediaType: 'image/png', sizeBytes: portrait.length } }];
selected.set(stressed.key, stressed);
export const layoutSnapshots = [...selected.values()];

export async function installLayoutSession(page, { submitted = false, locale = 'zh-CN', failPositionOnce = false } = {}) {
  await page.addInitScript(({ snapshots, image, portrait, audio, submitted, locale, failPositionOnce }) => {
    sessionStorage.setItem('practiq-preview', 'local');
    window.isTauri = false;
    const bank = { id: 'layout-bank', title: '布局检查题库', description: 'Synthetic browser fixture', count: snapshots.length, createdAt: 1 };
    const session = { id: 'layout-session', title: '布局检查 · 全题型', kind: 'practice', createdAt: 1, submittedAt: null, finishedAt: null, position: 0, mode: 'ordered', attempts: snapshots.map((snapshot, ordinal) => ({ ordinal, snapshot, answer: submitted ? snapshot.question.answerPayload : null, autoResult: null, result: null, gradeKind: 'ungraded', maxCents: null, earnedCents: null, submittedAt: submitted ? 1 : null, skipped: false, elapsedMs: 0 })) };
    window.__layoutNativeCalls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.__layoutNativeCalls.push({ command, request: args?.request });
      if (command === 'read_asset') {
        const visual = snapshots.find(s => s.key === 'rich-choice').visuals[0];
        return Uint8Array.from(args.hash === visual.imageRef.sha256 ? image : args.hash === visual.sourceRef.sha256 ? portrait : audio).buffer;
      }
      if (command !== 'request') throw Error(`Unexpected layout mock command: ${command}`);
      const request = args.request;
      switch (request.type) {
        case 'language': return locale;
        case 'banks': return [bank];
        case 'info': return { version: 'Browser layout mock', dataDirectory: '/mock' };
        case 'banks_page': return { items: [bank], total: 1, offset: 0 };
        case 'sessions_page': return { items: [{ ...session, attempts: undefined, count: snapshots.length, answered: submitted ? snapshots.length : 0, draftAnswered: 0, correct: 0, graded: 0, skipped: 0, elapsedMs: 0, autoGraded: 0, selfGraded: 0, pendingGrades: 0, totalCents: 0, earnedCents: 0, lastActiveAt: 1 }], total: 1, offset: 0 };
        case 'session': return structuredClone(session);
        case 'position':
          if (failPositionOnce) { failPositionOnce = false; throw { code:'OPERATION_FAILED', diagnostic:'Navigation unavailable (synthetic). '.repeat(12) }; }
          session.position = request.position; return structuredClone(session);
        case 'save_draft': return null;
        case 'listening_playback': return { used: 0, position: 0, active: false, limit: 2, restricted: false };
        default: throw Error(`Unexpected layout mock request: ${request.type}`);
      }
    } };
  }, { snapshots: layoutSnapshots, image: [...layoutImage], portrait: [...portrait], audio: [...audio], submitted, locale, failPositionOnce });
}
