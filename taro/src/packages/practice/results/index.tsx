import { Button } from "@taroify/core";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useState } from "react";
import { api } from "../../../api";
import { errorMessage } from "../../../api/message";
import { EntityCard, MetricCard, Page, PageHeader, Section, StateView, StatusTag } from "../../../components/ui";
import { openPage, routeNumber } from "../../../navigation";

interface ResultRow { id: number; question_id: number; stem: string; is_correct: boolean | null; score: number | null; max_score: number | null; answer_payload: unknown; answer_key_payload: unknown; analysis?: string | null }
export default function PracticeResultsPage(): JSX.Element {
  const id = routeNumber("id"); const [rows, setRows] = useState<ResultRow[] | null>(null); const [message, setMessage] = useState(""); const load = useCallback(async () => { if (!id) { setMessage("练习参数无效"); return; } try { setRows(await api.practice.results(id) as ResultRow[]); } catch (error) { setMessage(errorMessage(error)); } }, [id]); Taro.useDidShow(() => { void load(); });
  if (!rows) return <Page>{message ? <StateView phase="error" title="结果加载失败" detail={message} actionLabel="重试" onAction={() => void load()} /> : <StateView phase="loading" title="正在生成练习结果" detail="马上就好。" />}</Page>;
  const correct = rows.filter((item) => item.is_correct).length;
  return <Page><PageHeader eyebrow="练习完成" title="这次的进步已记录" subtitle="查看答案后，回到题库开始下一轮练习。" /><View className="stat-grid"><MetricCard label="作答" value={rows.length} unit="题" /><MetricCard label="正确" value={correct} unit="题" tone="success" /><MetricCard label="正确率" value={rows.length ? Math.round(correct / rows.length * 100) : 0} unit="%" /></View><Section title="逐题结果"><View className="list-stack">{rows.map((item) => <EntityCard key={item.id} title={item.stem} meta={item.analysis || "暂无解析"} badge={<StatusTag tone={item.is_correct ? "success" : "danger"}>{item.is_correct ? "正确" : "错误"}</StatusTag>} onClick={() => void openPage("/packages/content/questions/detail/index", { id: item.question_id })} />)}</View></Section><View className="button-row"><Button color="primary" onClick={() => void Taro.switchTab({ url: "/pages/banks/index" })}>返回题库</Button><Button onClick={() => void openPage("/packages/tools/analytics/index")}>查看分析</Button></View></Page>;
}
