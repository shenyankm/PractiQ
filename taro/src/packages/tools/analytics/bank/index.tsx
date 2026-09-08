import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../../auth/protected-page";
import { View } from "@tarojs/components";
import { useState } from "react";
import { errorMessage } from "../../../../api/message";
import {
  EntityCard,
  MetricCard,
  Page,
  PageHeader,
  Section,
  StateView,
} from "../../../../components/ui";
import { routeNumber } from "../../../../navigation";

function BankAnalyticsPage(): JSX.Element {
  const api = usePageApi();
  const id = routeNumber("id");
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [board, setBoard] = useState<Record<string, unknown>[]>([]);
  const [message, setMessage] = useState("");
  usePageLoad(async () => {
    if (!id) return;
    await Promise.all([api.analytics.bank(id), api.analytics.leaderboard(id)])
      .then(([value, users]) => {
        setStats(value);
        setBoard(users);
      })
      .catch((error) => setMessage(errorMessage(error)));
  });
  if (!stats)
    return (
      <Page>
        <StateView
          phase={message ? "error" : "loading"}
          title={message ? "题库分析加载失败" : "正在统计题库"}
          detail={message || "马上就好。"}
        />
      </Page>
    );
  return (
    <Page>
      <PageHeader
        eyebrow="题库分析"
        title={`题库 #${id}`}
        subtitle="汇总有权限查看的练习数据。"
      />
      <View className="stat-grid">
        <MetricCard label="作答" value={String(stats.answer_count ?? 0)} />
        <MetricCard
          label="练习人数"
          value={String(stats.practiced_users ?? 0)}
        />
        <MetricCard
          label="错误"
          value={String(stats.wrong_count ?? 0)}
          tone="warning"
        />
      </View>
      <Section title="排行榜">
        <View className="list-stack">
          {board.length ? (
            board.map((item, index) => (
              <EntityCard
                key={String(item.user_id)}
                title={`${index + 1}. ${String(item.display_name || "匿名学习者")}`}
                meta={`完成 ${String(item.completed_count)} · 正确率 ${String(item.accuracy_percent)}%`}
              />
            ))
          ) : (
            <StateView
              phase="empty"
              title="暂无排行数据"
              detail="完成练习后会显示排名。"
            />
          )}
        </View>
      </Section>
    </Page>
  );
}

export default protectedPage(BankAnalyticsPage);
