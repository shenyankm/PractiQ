import { expect, it } from "vitest";
import { importTaskState } from "./import-task-state";

it("keeps parser states authoritative and binds import operations to the current result", () => {
  const task = { state: "COMPLETED", checkpointId: "new", importedBankId: null };
  for (const state of ["PENDING", "RUNNING", "PAUSING", "PAUSED", "INTERRUPTED", "FAILED", "WAITING_REVIEW", "EXPIRED"]) {
    expect(importTaskState({ ...task, state }, { checkpointId: "new", state: "failed" })).toBe(state);
  }
  expect(importTaskState(task)).toBe("READY");
  expect(importTaskState(task, { checkpointId: "new", state: "importing" })).toBe("IMPORTING");
  expect(importTaskState(task, { checkpointId: "new", state: "failed" })).toBe("IMPORT_FAILED");
  expect(importTaskState(task, { checkpointId: "old", state: "failed" })).toBe("READY");
  expect(importTaskState({ ...task, importedBankId: "bank" }, { checkpointId: "new", state: "failed" })).toBe("IMPORTED");
  expect(importTaskState({ ...task, state: "RUNNING", importedBankId: "old-bank" })).toBe("RUNNING");
  expect(importTaskState({ ...task, state: "EXPIRED", importedBankId: "bank" })).toBe("EXPIRED");
});
