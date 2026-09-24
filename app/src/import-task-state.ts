import type { ImportOperation, Summary } from "./ai-api";

export function importTaskState(task: Pick<Summary, "state" | "checkpointId" | "importedBankId">, operation?: ImportOperation): string {
  if (task.state === "EXPIRED") return "EXPIRED";
  if (task.state !== "COMPLETED") return task.state;
  if (task.importedBankId) return "IMPORTED";
  if (operation?.checkpointId === task.checkpointId) {
    if (operation?.state === "importing") return "IMPORTING";
    if (operation?.state === "failed") return "IMPORT_FAILED";
  }
  return "READY";
}
