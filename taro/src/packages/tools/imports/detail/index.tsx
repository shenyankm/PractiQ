import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../../auth/protected-page";
import { Button } from "@taroify/core";
import { Text, View } from "@tarojs/components";
import { useDidHide } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { viewAccess } from "../../../../auth/view-access";
import type { ImportJob } from "../../../../api/modules";
import { errorMessage } from "../../../../api/message";
import {
  ErrorNotice,
  Page,
  PageHeader,
  Section,
  StateView,
  StatusTag,
  confirmDanger,
} from "../../../../components/ui";
import { routeNumber } from "../../../../navigation";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
function ImportDetailPage(): JSX.Element {
  const api = usePageApi();
  const id = routeNumber("id");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [events, setEvents] = useState<unknown[]>([]);
  const [outputs, setOutputs] = useState<unknown[]>([]);
  const [message, setMessage] = useState("");
  const active = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delay = useRef(2000);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    const unsubscribe = viewAccess.subscribe((event) => {
      if (event !== "revalidate") {
        active.current = false;
        stop();
      }
    });
    return () => {
      active.current = false;
      stop();
      unsubscribe();
    };
  }, []);
  const load = useCallback(async () => {
    if (!id || !active.current) return;
    stop();
    try {
      const next = await api.imports.get(id);
      if (!active.current) return;
      setJob(next);
      setMessage("");
      if (TERMINAL.has(next.status)) {
        const [nextEvents, nextOutputs] = await Promise.all([
          api.imports.children(id, "events"),
          api.imports.children(id, "outputs"),
        ]);
        setEvents(nextEvents);
        setOutputs(nextOutputs);
        stop();
      } else if (active.current) {
        timer.current = setTimeout(() => void load(), delay.current);
        delay.current = Math.min(5000, delay.current + 500);
      }
    } catch (error) {
      setMessage(errorMessage(error));
      if (active.current) timer.current = setTimeout(() => void load(), 5000);
    }
  }, [id]);
  usePageLoad(async () => {
    active.current = true;
    delay.current = 2000;
    await load();
  });
  useDidHide(() => {
    active.current = false;
    stop();
  });
  if (!job)
    return (
      <Page>
        <StateView
          phase={message ? "error" : "loading"}
          title={message ? "任务读取失败" : "正在读取任务"}
          detail={message || "马上就好。"}
          actionLabel={message ? "重试" : undefined}
          onAction={message ? () => void load() : undefined}
        />
      </Page>
    );
  const action = async (name: "retry" | "cancel") => {
    if (
      name === "cancel" &&
      !(await confirmDanger(
        "取消导入",
        "正在处理的任务会进入取消终态，确定继续吗？",
        "取消任务",
      ))
    )
      return;
    try {
      setJob(await api.imports.action(job.id, name));
      delay.current = 2000;
      void load();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  return (
    <Page>
      <PageHeader
        eyebrow="导入任务"
        title={job.source_file_name || `任务 #${job.id}`}
        subtitle={`任务编号 ${job.id}`}
        action={
          <StatusTag
            tone={
              job.status === "completed"
                ? "success"
                : job.status === "failed"
                  ? "danger"
                  : "warning"
            }
          >
            {job.status}
          </StatusTag>
        }
      />
      {message ? <ErrorNotice>{message}</ErrorNotice> : null}
      <Section title="处理进度">
        <View className="form-card app-stack">
          <Text className="app-muted">
            状态会从 2 秒开始轮询，逐步退避到 5 秒；页面隐藏后自动停止。
          </Text>
          <Text>
            事件 {events.length} 条 · 输出 {outputs.length} 条
          </Text>
          <View className="button-row">
            {TERMINAL.has(job.status) ? null : (
              <Button
                color="danger"
                variant="outlined"
                onClick={() => void action("cancel")}
              >
                取消任务
              </Button>
            )}
            {job.status === "failed" ? (
              <Button color="primary" onClick={() => void action("retry")}>
                重试
              </Button>
            ) : null}
          </View>
        </View>
      </Section>
      {outputs.length ? (
        <Section title="解析输出">
          <View className="form-card">
            <Text className="app-number">
              {JSON.stringify(outputs, null, 2)}
            </Text>
          </View>
        </Section>
      ) : null}
    </Page>
  );
}

export default protectedPage(ImportDetailPage);
