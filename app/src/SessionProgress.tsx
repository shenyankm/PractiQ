import { useEffect, useRef, useState } from "react";
import type { UnfinishedSession } from "./api";
import { duration, t, useI18n } from "./i18n";

export function SessionProgress({ session, active = true, onExpired }: { session: UnfinishedSession; active?: boolean; onExpired?: () => void }) {
  useI18n();
  const base = session.clockNow;
  const [clock, setClock] = useState({ base, now: base ?? 0 });
  const now = clock.base === base ? clock.now : base ?? 0;
  const expired = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !session.deadlineAt || base == null) return;
    const started = performance.now();
    const timer = window.setInterval(() => setClock({ base, now: base + performance.now() - started }), 1000);
    return () => window.clearInterval(timer);
  }, [active, session.deadlineAt, base]);
  useEffect(() => {
    const key = `${session.id}:${session.deadlineAt}`;
    if (active && base != null && session.deadlineAt != null && now >= session.deadlineAt && expired.current !== key) {
      expired.current = key;
      onExpired?.();
    }
  }, [active, session.id, session.deadlineAt, base, now, onExpired]);
  const exam = session.kind && session.kind !== "practice";
  return <span>
    {exam && active
      ? t("已答 {0}/{1} 题 · 草稿已保存", { 0: session.draftAnswered ?? 0, 1: session.count })
      : t("已提交 {0}/{1} 题", { 0: session.answered, 1: session.count })}
    {active && base != null && session.deadlineAt != null && <> · {session.deadlineAt > now
      ? t("剩余 {0}", { 0: duration(session.deadlineAt - now) })
      : t("已到交卷时间，请打开核对成绩")}</>}
  </span>;
}
