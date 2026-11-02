// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionNotesButton } from "./QuestionNotes";
import { api } from "./api";

vi.mock("./api",async()=>({...await vi.importActual("./api"),api:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("loads only when opened and saves explicit edits and cause",async()=>{
  const user=userEvent.setup();vi.mocked(api).mockResolvedValueOnce(null).mockResolvedValueOnce({body:"Check units",cause:"calculation",updatedAt:1} as never);
  render(<QuestionNotesButton id="q"/>);expect(api).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button",{name:"笔记与错因"}));
  await user.type(await screen.findByLabelText("个人笔记"),"Check units");await user.selectOptions(screen.getByLabelText("错因"),"calculation");
  await user.click(screen.getByRole("button",{name:"保存"}));
  await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
  expect(api).toHaveBeenLastCalledWith({type:"save_question_note",id:"q",body:"Check units",cause:"calculation"});
});
it("retains a failed-save draft and protects cancellation",async()=>{
  const user=userEvent.setup();vi.mocked(api).mockResolvedValueOnce(null).mockRejectedValueOnce(Error("Save failed"));
  render(<QuestionNotesButton id="q"/>);await user.click(screen.getByRole("button",{name:"笔记与错因"}));
  await user.type(await screen.findByLabelText("个人笔记"),"My draft");await user.click(screen.getByRole("button",{name:"保存"}));
  await screen.findByRole("alert");expect((screen.getByLabelText("个人笔记") as HTMLTextAreaElement).value).toBe("My draft");
  await user.click(screen.getByRole("button",{name:"取消"}));await screen.findByRole("alertdialog");
  await user.click(screen.getByRole("button",{name:"继续编辑"}));expect((screen.getByLabelText("个人笔记") as HTMLTextAreaElement).value).toBe("My draft");
  await user.keyboard("{Escape}");await user.click(screen.getByRole("button",{name:"放弃更改"}));
  await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
});
it("retries a failed read without editing or saving",async()=>{
  const user=userEvent.setup();vi.mocked(api).mockRejectedValueOnce(Error("Read failed")).mockResolvedValueOnce({body:"Retained",cause:null,updatedAt:1} as never);
  render(<QuestionNotesButton id="q"/>);await user.click(screen.getByRole("button",{name:"笔记与错因"}));
  await screen.findByRole("alert");expect(screen.queryByLabelText("个人笔记")).toBeNull();
  await user.click(screen.getByRole("button",{name:"重试"}));expect((await screen.findByLabelText("个人笔记") as HTMLTextAreaElement).value).toBe("Retained");expect(api).toHaveBeenCalledTimes(2);
});
