import { Text, View } from "@tarojs/components";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { useCallback, useState } from "react";
import { apiClient } from "../../api";
import type { AnalyticsSnapshot } from "../../api/contracts";
import { errorMessage } from "../../api/message";
import { requiresLogin } from "../../auth/guard";
import { sessionStore } from "../../auth/session";
import { CACHE_TTL, cachedForUser } from "../../cache";
import { EntityCard, MetricCard, Page, PageHeader, Section, StateView, StatusTag } from "../../components/ui";
import { openPage } from "../../navigation";
import "./index.css";

export default function HomePage(): JSX.Element {
  const [data, setData] = useState<AnalyticsSnapshot | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const load = useCallback(async (fresh = false) => { const snapshot = sessionStore.getSnapshot(); if (requiresLogin(snapshot)) { void Taro.reLaunch({ url: "/pages/login/index" }); return; } setLoading(true); setError(""); try { setData(await cachedForUser(snapshot!.user.id, "analytics:me", CACHE_TTL.analytics, () => apiClient.getAnalyticsSnapshot(), !fresh)); } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); } }, []);
  useDidShow(() => { void load(); }); usePullDownRefresh(() => { void load(true).finally(() => void Taro.stopPullDownRefresh()); });
  const user = sessionStore.getSnapshot()?.user;
  return <Page tab><PageHeader eyebrow="学习" title={user?.displayName ? `${user.displayName}，继续加油` : "今天也来练一练"} subtitle="从最近一次练习继续，或者查看自己的薄弱点。" />
    {loading && !data ? <StateView phase="loading" title="正在整理学习数据" detail="统计与最近练习马上就好。" /> : null}{error && !data ? <StateView phase="error" title="学习数据加载失败" detail={error} actionLabel="重新加载" onAction={() => void load(true)} /> : null}
    {data ? <><View className="stat-grid"><MetricCard label="累计作答" value={data.summary.attempts} unit="题" /><MetricCard label="正确率" value={data.summary.accuracy} unit="%" tone="success" /><MetricCard label="练习场次" value={data.summary.sessions} unit="次" /><MetricCard label="待处理导入" value={data.summary.active_imports} unit="个" tone="warning" /></View>
      <Section title="快速开始" description="选择一个入口，保持今天的学习节奏。"><View className="nav-grid"><Nav title="开始练习" detail="从题库选择练习内容" onClick={() => void Taro.switchTab({ url: "/pages/banks/index" })} /><Nav title="统一搜索" detail="查找题目和知识点" onClick={() => void openPage("/packages/tools/search/index")} /><Nav title="导入题目" detail="上传文件并交给 AI 解析" onClick={() => void openPage("/packages/tools/imports/index")} /><Nav title="学习分析" detail="查看趋势和薄弱项" onClick={() => void openPage("/packages/tools/analytics/index")} /></View></Section>
      <Section title="最近练习" description="返回未完成的练习，或复盘已经结束的场次。"><View className="list-stack">{data.recentSessions.length ? data.recentSessions.map((session) => <EntityCard key={session.id} title={`题库 #${session.bank_id}`} meta={`${session.answered_count}/${session.question_count} 题 · 正确 ${session.correct_count}`} badge={<StatusTag tone={session.status === "active" ? "warning" : "success"}>{session.status === "active" ? "进行中" : "已完成"}</StatusTag>} onClick={() => void openPage(session.status === "active" ? "/packages/practice/session/index" : "/packages/practice/results/index", { id: session.id })} />) : <StateView phase="empty" title="还没有练习记录" detail="去题库选择一份内容开始练习吧。" />}</View></Section>
      {data.weakQuestions.length ? <Section title="需要巩固"><View className="list-stack">{data.weakQuestions.map((item) => <EntityCard key={item.question_id} title={item.stem} meta={`题型 ${item.question_type_id} · 错误 ${item.wrong_count} 次`} onClick={() => void openPage("/packages/content/questions/detail/index", { id: item.question_id })} />)}</View></Section> : null}</> : null}
  </Page>;
}
function Nav({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }): JSX.Element { return <View className="nav-card" role="button" onClick={onClick}><Text className="nav-card-title">{title}</Text><Text className="nav-card-detail">{detail}</Text></View>; }
