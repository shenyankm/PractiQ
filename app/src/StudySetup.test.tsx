// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StudySetup } from "./StudySetup";
import { api, type QuestionRow, type Session } from "./api";
import fixture from "../fixtures/sample.json";
vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const banks = [{id:"one",title:"题库一",count:2,description:"",createdAt:0}, {id:"two",title:"题库二",count:1,description:"",createdAt:0}];
const rows = fixture.questions.slice(0,2).map((question,i) => ({id:`q${i}`,bankId:"one",bankTitle:"题库一",question,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null})) as QuestionRow[];
function setup() {
  const onStart = vi.fn(async (_s: Session) => {});
  vi.mocked(api).mockImplementation(async r => (r.type === "questions" ? rows : {id:"session"}) as never);
  render(<StudySetup banks={banks} initialBank="one" initialFilter="" busy={false} run={job => { void job(); }} onStart={onStart} onClose={() => {}}/>);
  return onStart;
}
it("starts ordinary practice directly with the selected questions and no exam scores", async () => {
  const started = setup();
  const button = screen.getByRole("button",{name:"立即开始"});
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(screen.queryByRole("button",{name:/预览题目/})).toBeNull();
  await userEvent.click(button);
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith({type:"start_paper",paper:{question_ids:["q0","q1"],kind:"practice",minutes:null,scores:[],total_cents:0}});
});
it("never turns clearing the last selected bank into all banks", async () => {
  setup();
  await screen.findByText(/可用 2 题/);
  await userEvent.click(screen.getByText(/高级设置/, { selector: "summary" }));
  await userEvent.click(screen.getByRole("checkbox",{name:"题库一（2）"}));
  expect(await screen.findByText("请选择至少一个题库")).toBeTruthy();
  expect(screen.getByRole("button",{name:"立即开始"}).hasAttribute("disabled")).toBe(true);
  expect(vi.mocked(api).mock.calls.filter(([r])=>r.type === "questions")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button",{name:"全选可用题库"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({bank_ids:["one","two"]})));
});
it("requires a fresh exam preview and validates the score total", async () => {
  setup();
  await screen.findByText(/可用 2 题/);
  await userEvent.selectOptions(screen.getByLabelText("模式"), "self_test");
  expect(screen.queryByRole("button",{name:"开始考试"})).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"预览题目与配分"}));
  await userEvent.clear(screen.getByLabelText("第 1 题分值"));
  await userEvent.type(screen.getByLabelText("第 1 题分值"), "40");
  await userEvent.click(screen.getByRole("button",{name:"开始考试"}));
  expect(screen.getByRole("alert").textContent).toContain("分值之和必须等于总分");
  expect(vi.mocked(api).mock.calls.some(([r])=>r.type === "start_paper")).toBe(false);
  await userEvent.clear(screen.getByLabelText("考试总分"));
  await userEvent.type(screen.getByLabelText("考试总分"), "90");
  expect(screen.queryByRole("button",{name:"开始考试"})).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"预览题目与配分"}));
  await userEvent.click(screen.getByRole("button",{name:"开始考试"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith({type:"start_paper",paper:{question_ids:["q0","q1"],kind:"self_test",minutes:null,scores:[4500,4500],total_cents:9000}}));
});
it("keeps manual and per-type question selection available for practice", async () => {
  setup();
  await screen.findByText(/可用 2 题/);
  await userEvent.click(screen.getByText(/高级设置/, { selector: "summary" }));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "quota");
  await userEvent.clear(screen.getByLabelText("单选题数"));
  await userEvent.type(screen.getByLabelText("单选题数"), "1");
  await userEvent.click(screen.getByRole("button",{name:"立即开始"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"start_paper",paper:expect.objectContaining({question_ids:["q0"]})})));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "manual");
  await userEvent.click(screen.getByRole("checkbox",{name:rows[1].question.stem!}));
  await userEvent.click(screen.getByRole("button",{name:"立即开始"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"start_paper",paper:expect.objectContaining({question_ids:["q1"]})})));
});
