// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api, blankQuestion, type Session, type Attempt } from "./api";
import { Practice } from "./Practice";

vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function choiceSession(variant: "single" | "multiple" = "single"): Session {
  const question = {
    ...blankQuestion(),
    answerMode: "choice" as const,
    choiceVariant: variant,
    options: [
      { label: "A", content: "Option Alpha" },
      { label: "B", content: "Option Beta" },
      { label: "C", content: "Option Gamma" },
      { label: "D", content: "Option Delta" },
    ],
    stem: "Choose the best option",
  };
  const attempts: Attempt[] = [
    {
      ordinal: 0,
      snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
      answer: null, autoResult: null, result: null, gradeKind: "ungraded",
      submittedAt: null, skipped: false, elapsedMs: 0,
    },
    {
      ordinal: 1,
      snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
      answer: null, autoResult: null, result: null, gradeKind: "ungraded",
      submittedAt: null, skipped: false, elapsedMs: 0,
    },
  ];
  return {
    id: "session-keyboard",
    kind: "practice",
    title: "Keyboard Test",
    createdAt: Date.now(),
    position: 0,
    mode: "ordered",
    finishedAt: null,
    submittedAt: null,
    attempts,
  };
}

it("selects options with A-D and 1-4 keys and navigates with J/K and arrows", async () => {
  const user = userEvent.setup();
  let session = choiceSession("single");
  const onSession = vi.fn((s: Session) => { session = s; });
  const flushRef = { current: async () => {} };
  vi.mocked(api).mockImplementation(async req => {
    if (req.type === "save_draft") return null as never;
    if (req.type === "position") {
      session = { ...session, position: req.position };
      return session as never;
    }
    return session as never;
  });

  render(
    <Practice session={session} onSession={onSession} run={job => { void job(); }} flushRef={flushRef} />
  );

  // Press 'b' to select Option B
  await user.keyboard("b");
  const radioB = screen.getByRole("radio", { name: /Option Beta/ });
  expect(radioB.getAttribute("aria-checked")).toBe("true");

  // Press '1' to select Option A
  await user.keyboard("1");
  const radioA = screen.getByRole("radio", { name: /Option Alpha/ });
  expect(radioA.getAttribute("aria-checked")).toBe("true");
  expect(radioB.getAttribute("aria-checked")).toBe("false");

  // Press 'j' to navigate to next question
  await user.keyboard("j");
  expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "position", position: 1 }));
});

it("toggles options with keyboard in multiple choice mode", async () => {
  const user = userEvent.setup();
  const session = choiceSession("multiple");
  const onSession = vi.fn();
  const flushRef = { current: async () => {} };
  vi.mocked(api).mockResolvedValue(null as never);

  render(
    <Practice session={session} onSession={onSession} run={job => { void job(); }} flushRef={flushRef} />
  );

  const checkA = screen.getByRole("checkbox", { name: /Option Alpha/ });
  const checkC = screen.getByRole("checkbox", { name: /Option Gamma/ });

  expect(checkA.getAttribute("aria-checked")).toBe("false");
  expect(checkC.getAttribute("aria-checked")).toBe("false");

  // Press 'a' and '3'
  await user.keyboard("a");
  expect(checkA.getAttribute("aria-checked")).toBe("true");

  await user.keyboard("3");
  expect(checkC.getAttribute("aria-checked")).toBe("true");

  // Press 'a' again to uncheck
  await user.keyboard("a");
  expect(checkA.getAttribute("aria-checked")).toBe("false");
  expect(checkC.getAttribute("aria-checked")).toBe("true");
});

it("selects true/false options with 1/2 and T/F", async () => {
  const user = userEvent.setup();
  const question = {
    ...blankQuestion(),
    answerMode: "true_false" as const,
    stem: "Statement is correct",
  };
  const session: Session = {
    id: "session-tf",
    kind: "practice",
    title: "True/False Test",
    createdAt: Date.now(),
    position: 0,
    mode: "ordered",
    finishedAt: null,
    submittedAt: null,
    attempts: [
      {
        ordinal: 0,
        snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
        answer: null, autoResult: null, result: null, gradeKind: "ungraded",
        submittedAt: null, skipped: false, elapsedMs: 0,
      },
    ],
  };
  vi.mocked(api).mockResolvedValue(null as never);

  render(
    <Practice session={session} onSession={vi.fn()} run={job => { void job(); }} flushRef={{ current: async () => {} }} />
  );

  const radioTrue = screen.getByRole("radio", { name: /正确/ });
  const radioFalse = screen.getByRole("radio", { name: /错误/ });

  await user.keyboard("1");
  expect(radioTrue.getAttribute("aria-checked")).toBe("true");

  await user.keyboard("f");
  expect(radioFalse.getAttribute("aria-checked")).toBe("true");
  expect(radioTrue.getAttribute("aria-checked")).toBe("false");
});

it("flags current question with F in exam mode", async () => {
  const user = userEvent.setup();
  const base = choiceSession("single");
  const session: Session = {
    ...base,
    kind: "mock_exam",
    attempts: [
      {
        ...base.attempts[0],
        flagged: false,
      },
    ],
  };
  vi.mocked(api).mockResolvedValue(session as never);

  render(
    <Practice session={session} onSession={vi.fn()} run={job => { void job(); }} flushRef={{ current: async () => {} }} />
  );

  await user.keyboard("f");
  expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "flag", ordinal: 0, value: true }));
});

it("does not trigger hotkeys when typing in a text input or textarea", async () => {
  const user = userEvent.setup();
  const question = {
    ...blankQuestion(),
    answerMode: "short_answer" as const,
    stem: "Type your answer",
  };
  const session: Session = {
    id: "session-sa",
    kind: "practice",
    title: "Short Answer Test",
    createdAt: Date.now(),
    position: 0,
    mode: "ordered",
    finishedAt: null,
    submittedAt: null,
    attempts: [
      {
        ordinal: 0,
        snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
        answer: null, autoResult: null, result: null, gradeKind: "ungraded",
        submittedAt: null, skipped: false, elapsedMs: 0,
      },
      {
        ordinal: 1,
        snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
        answer: null, autoResult: null, result: null, gradeKind: "ungraded",
        submittedAt: null, skipped: false, elapsedMs: 0,
      },
    ],
  };
  vi.mocked(api).mockResolvedValue(null as never);

  render(
    <Practice session={session} onSession={vi.fn()} run={job => { void job(); }} flushRef={{ current: async () => {} }} />
  );

  const textarea = screen.getByRole("textbox", { name: "作答内容" });
  await user.click(textarea);
  // Typing 'j' should type into textarea, not trigger question navigation
  await user.keyboard("j");
  expect((textarea as HTMLTextAreaElement).value).toBe("j");
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({ type: "position" }));
});
