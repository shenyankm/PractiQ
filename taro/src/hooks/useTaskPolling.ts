import { useDidHide } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePageLoad } from "../auth/protected-page";
import { viewAccess } from "../auth/view-access";
import type { AiTask } from "../api/modules";
import { TERMINAL_AI_STATUSES, taskPollDelay } from "../polling";

export function useTaskPolling(taskId: number | null, getTask: (id: number) => Promise<AiTask>) {
  const [task, setTask] = useState<AiTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(async () => {
    stop();
    if (!taskId || !active.current) return;
    try {
      const next = await getTask(taskId);
      if (!active.current) return;
      setTask(next);
      setError(null);
      failures.current = 0;
      if (!TERMINAL_AI_STATUSES.has(next.status) && active.current) timer.current = setTimeout(() => void poll(), 2000);
    } catch (reason) {
      failures.current += 1;
      setError(reason instanceof Error ? reason.message : "任务状态读取失败");
      if (active.current) timer.current = setTimeout(() => void poll(), taskPollDelay(failures.current));
    }
  }, [getTask, taskId]);

  usePageLoad(async () => { active.current = true; await poll(); });
  useEffect(() => viewAccess.subscribe((event) => { if (event !== "revalidate") { active.current = false; stop(); setTask(null); } }), [stop]);
  useDidHide(() => { active.current = false; stop(); });
  useEffect(() => {
    active.current = true;
    setTask(null);
    void poll();
    return () => { active.current = false; stop(); };
  }, [poll, stop]);
  return { task, error, refresh: poll, stop };
}
