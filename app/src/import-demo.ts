import type { Summary, Task } from "./ai-api";

const examples: [Summary["state"], string, string, number, number][] = [
  ["RUNNING", "高等数学 · 极限与连续", "高等数学第一章.pdf", 18, 2],
  ["PENDING", "大学英语 · 阅读理解", "阅读训练.docx", 0, 0],
  ["PAUSING", "计算机网络 · 传输层", "传输层习题.pdf", 12, 1],
  ["PAUSED", "数据结构 · 树与图", "树与图.pdf", 26, 3],
  ["COMPLETED", "线性代数 · 矩阵", "矩阵练习.xlsx", 40, 2],
  ["CANCELLED", "操作系统 · 进程管理", "进程管理.txt", 8, 0],
  ["FAILED", "概率论 · 随机变量", "随机变量.pdf", 10, 2],
  ["WAITING_REVIEW", "数据库 · SQL 基础", "SQL练习.csv", 32, 5],
  ["INTERRUPTED", "软件工程 · 需求分析", "需求分析.docx", 15, 1],
  ["EXPIRED", "离散数学 · 集合与关系", "集合与关系.pdf", 20, 0],
];
export const importDemoRows: Summary[] = examples.map(([state, bankTitle, fileName, questionCount, reviewCount], index) => ({
  threadId: `demo-${String(index + 1).padStart(3, "0")}`, bankTitle, fileName, state, questionCount, reviewCount,
  bankDescription: "用于预览导入记录布局、状态筛选和详情的示例，不包含真实解析结果。",
  checkpointId: `demo-checkpoint-${index}`, status: state === "COMPLETED" ? "SUCCEEDED" : state === "WAITING_REVIEW" ? "PARTIAL" : null,
  createdAt: `2026-09-28T${String(12 - index).padStart(2, "0")}:00:00Z`, expiresAt: state === "EXPIRED" ? "2026-09-27T00:00:00Z" : "2027-03-27T00:00:00Z",
}));
export function importDemoTask(id: string): Task {
  const row = importDemoRows.find(row => row.threadId === id)!;
  const succeeded = row.state === "COMPLETED" ? 8 : 3;
  const failed = row.state === "FAILED" ? 1 : 0;
  return {
    threadId: id, runId: null, parentThreadId: null, checkpointId: row.checkpointId,
    modelConfigured: false, resumeCompatible: false, fileName: row.fileName,
    updatedAt: row.createdAt, expiresAt: row.expiresAt, state: row.state, status: row.status,
    phase: row.state === "COMPLETED" ? "completed" : "chunk",
    result: null, processing: null, modelBudget: {limit: 2000, reserved: 0},
    allowedActions: [], blocking: [],
    failures: row.state === "FAILED" ? [{retryable: true, stage: "document_parse", index: 0, code: "DEMO_ERROR", retriesRemaining: 2}] : [],
    progress: {
      visuals: {total: 0, succeeded: 0, failed: 0, remaining: 0},
      chunks: {total: 8, succeeded, failed, remaining: 8 - succeeded - failed},
    },
    usage: [], unknownUsageCalls: [],
  };
}
