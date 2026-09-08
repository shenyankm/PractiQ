import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../auth/protected-page";
import { Button } from "@taroify/core";
import { Text, View } from "@tarojs/components";
import { useCallback, useState } from "react";
import type { AnalyticsSnapshot } from "../../../api/contracts";
import { errorMessage } from "../../../api/message";
import {
  EntityCard,
  MetricCard,
  Page,
  PageHeader,
  Section,
  StateView,
} from "../../../components/ui";
import { openPage } from "../../../navigation";
import { useTaskPolling } from "../../../hooks/useTaskPolling";

function AnalyticsPage(): JSX.Element {
  const api = usePageApi();
  const [data, setData] = useState<AnalyticsSnapshot | null>(null);
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState<number | null>(null);
  const report = useTaskPolling(taskId, api.aiTasks.get);
  const load = useCallback(async () => {
    try {
      setData(await api.analytics.snapshot());
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, []);
  usePageLoad(async () => {
    await load();
  });
  if (!data)
    return (
      <Page>
        <StateView
          phase={message ? "error" : "loading"}
          title={message ? "分析加载失败" : "正在生成学习分析"}
          detail={message || "马上就好。"}
          actionLabel={message ? "重试" : undefined}
          onAction={message ? () => void load() : undefined}
        />
      </Page>
    );
  return (
    <Page>
      <PageHeader
        eyebrow="个人分析"
        title="看清楚，再练一次"
        subtitle="数据来自你的练习记录，不包含其他用户的私有内容。"
      />
      <View className="stat-grid">
        <MetricCard label="累计作答" value={data.summary.attempts} />
        <MetricCard label="正确" value={data.summary.correct} tone="success" />
        <MetricCard label="错误" value={data.summary.wrong} tone="warning" />
        <MetricCard label="正确率" value={data.summary.accuracy} unit="%" />
      </View>
      <Section title="薄弱题目">
        <View className="list-stack">
          {data.weakQuestions.length ? (
            data.weakQuestions.map((item) => (
              <EntityCard
                key={`${item.bank_id}:${item.question_id}`}
                title={item.stem}
                meta={`作答 ${item.attempt_count} 次 · 错误 ${item.wrong_count} 次`}
                onClick={() =>
                  void openPage("/packages/content/questions/detail/index", {
                    id: item.question_id,
                  })
                }
              />
            ))
          ) : (
            <StateView
              phase="empty"
              title="暂无薄弱题目"
              detail="完成练习后这里会给出巩固建议。"
            />
          )}
        </View>
      </Section>
      {report.task ? (
        <Section title="AI 学习报告">
          <View className="form-card app-stack">
            <Text className="app-muted">任务状态：{report.task.status}</Text>
            {report.task.status === "succeeded" ? (
              <Text>{JSON.stringify(report.task.result, null, 2)}</Text>
            ) : null}
            {!["succeeded", "failed", "cancelled", "timed_out"].includes(
              report.task.status,
            ) && taskId ? (
              <Button
                size="small"
                variant="outlined"
                onClick={() =>
                  void api.aiTasks.cancel(taskId).then(() => report.refresh())
                }
              >
                取消任务
              </Button>
            ) : null}
          </View>
        </Section>
      ) : null}
      <Button
        color="primary"
        block
        shape="round"
        onClick={() =>
          void api.analytics
            .report({})
            .then((task) => setTaskId(task.id))
            .catch((error) => setMessage(errorMessage(error)))
        }
      >
        生成 AI 学习报告
      </Button>
    </Page>
  );
}

export default protectedPage(AnalyticsPage);
