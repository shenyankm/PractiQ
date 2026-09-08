import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../auth/protected-page";
import { Button } from "@taroify/core";
import { View } from "@tarojs/components";
import { useCallback, useState } from "react";
import type { ImportJob } from "../../../api/modules";
import { errorMessage } from "../../../api/message";
import {
  EntityCard,
  Page,
  PageHeader,
  StateView,
  StatusTag,
} from "../../../components/ui";
import { openPage } from "../../../navigation";

function ImportsPage(): JSX.Element {
  const api = usePageApi();
  const [items, setItems] = useState<ImportJob[] | null>(null);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      setItems((await api.imports.list({ limit: 50 })).items);
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, []);
  usePageLoad(async () => {
    await load();
  });
  return (
    <Page>
      <PageHeader
        eyebrow="AI 工具"
        title="题目导入"
        subtitle="上传文档后由持久化任务处理，退出页面不会丢失进度。"
        action={
          <Button
            color="primary"
            size="small"
            onClick={() =>
              void openPage("/packages/tools/imports/create/index")
            }
          >
            新建导入
          </Button>
        }
      />
      {items ? (
        <View className="list-stack">
          {items.length ? (
            items.map((item) => (
              <EntityCard
                key={item.id}
                title={item.source_file_name || `导入任务 #${item.id}`}
                meta={item.created_at || ""}
                description={`重试 ${item.retry_count || 0} 次`}
                badge={
                  <StatusTag tone={tone(item.status)}>
                    {label(item.status)}
                  </StatusTag>
                }
                onClick={() =>
                  void openPage("/packages/tools/imports/detail/index", {
                    id: item.id,
                  })
                }
              />
            ))
          ) : (
            <StateView
              phase="empty"
              title="还没有导入任务"
              detail="选择一个题库并上传 UTF-8 CSV、PDF、Word、Excel、图片或文本文件。"
            />
          )}
        </View>
      ) : (
        <StateView
          phase={message ? "error" : "loading"}
          title={message ? "导入列表加载失败" : "正在读取导入任务"}
          detail={message || "马上就好。"}
          actionLabel={message ? "重试" : undefined}
          onAction={message ? () => void load() : undefined}
        />
      )}
    </Page>
  );
}
function tone(status: string): "success" | "warning" | "danger" | "neutral" {
  return status === "completed"
    ? "success"
    : status === "failed" || status === "cancelled"
      ? "danger"
      : status === "queued" || status === "processing"
        ? "warning"
        : "neutral";
}
function label(status: string): string {
  return (
    (
      {
        queued: "排队中",
        processing: "处理中",
        completed: "已完成",
        failed: "失败",
        cancelled: "已取消",
      } as Record<string, string>
    )[status] || status
  );
}

export default protectedPage(ImportsPage);
