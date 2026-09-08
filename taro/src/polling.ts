export const TERMINAL_AI_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
export const taskPollDelay = (failures: number): number => Math.min(2000 + Math.max(0, failures) * 1000, 5000);
export const isPaymentTerminal = (status: string): boolean => status !== "pending";
