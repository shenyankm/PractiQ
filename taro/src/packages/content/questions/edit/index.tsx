import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../../auth/protected-page";
import { Button } from "@taroify/core";
import { Input, Picker, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  pendingTransfers,
  identifyTransferFile,
  verifyTransferFile,
} from "../../../../transfers/runtime";
import type {
  AnswerMode,
  QuestionOption,
  QuestionType,
} from "../../../../api/modules";
import { errorMessage } from "../../../../api/message";
import {
  ErrorNotice,
  Page,
  PageHeader,
  Section,
  confirmDanger,
} from "../../../../components/ui";
import { routeNumber } from "../../../../navigation";
import { useTaskPolling } from "../../../../hooks/useTaskPolling";

function QuestionEditPage(): JSX.Element {
  const api = usePageApi();
  const transferScope = useRef(pendingTransfers.scope()).current;
  const [uploading, setUploading] = useState(false);
  const dirty = useRef(new Set<string>());
  const id = routeNumber("id");
  const bankId = routeNumber("bankId");
  const taskId = routeNumber("taskId");
  const [stem, setStem] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [typeId, setTypeId] = useState("");
  const [answerMode, setAnswerMode] = useState<AnswerMode>("choice");
  const [answer, setAnswer] = useState("");
  const [options, setOptions] = useState<QuestionOption[]>([
    { option_label: "A", content: "" },
    { option_label: "B", content: "" },
  ]);
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const appliedTask = useRef<number | null>(null);
  const polling = useTaskPolling(taskId, api.aiTasks.get);
  useEffect(() => {
    if (
      !taskId ||
      polling.task?.status !== "succeeded" ||
      appliedTask.current === taskId ||
      !polling.task.result ||
      typeof polling.task.result !== "object"
    )
      return;
    const result = polling.task.result as Record<string, unknown>;
    const payload =
      result.answerPayload && typeof result.answerPayload === "object"
        ? (result.answerPayload as Record<string, unknown>)
        : {};
    const generated = Array.isArray(payload.correct)
      ? payload.correct.join(",")
      : String(
          payload.correctOption ??
            payload.answer ??
            payload.value ??
            result.canonicalAnswer ??
            "",
        );
    setAnswer(generated);
    if (typeof result.explanation === "string") setAnalysis(result.explanation);
    setMessage("AI 答案草稿已生成，请检查后保存为新的答案版本。");
    appliedTask.current = taskId;
  }, [polling.task, taskId]);
  const load = useCallback(async () => {
    try {
      if (!id && bankId) await api.banks.get(bankId);
      const subjects = await api.references.subjects();
      const available = subjects.length
        ? await api.references.questionTypes(subjects[0].subject_id)
        : [];
      setTypes(available);
      if (!typeId && available.length) {
        setTypeId(available[0].type_id);
        setAnswerMode(available[0].default_answer_mode);
      }
      if (id) {
        const question = await api.questions.management(id);
        if (!dirty.current.has("stem")) setStem(question.stem);
        if (!dirty.current.has("analysis"))
          setAnalysis(question.analysis || "");
        if (!dirty.current.has("type")) {
          setTypeId(question.question_type_id);
          setAnswerMode(question.answer_mode);
        }
        if (!dirty.current.has("options")) setOptions(question.options);
        const pending = pendingTransfers.mediaFor(transferScope, id);
        if (pending?.mediaId) await api.media.get(pending.mediaId);
        if (pending && !pending.mediaId) await verifyTransferFile(pending.file);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, [id, typeId]);
  usePageLoad(async () => {
    await load();
  });
  const save = async () => {
    if (!stem.trim()) {
      setMessage("请填写题干");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      if (id) {
        await api.questions.update(id, { stem: stem.trim(), analysis });
        if (answer.trim())
          await api.questions.answerKey(id, {
            answerMode,
            answerPayload: answerPayload(answerMode, answer),
            explanationPayload: { text: analysis },
          });
        await Taro.navigateBack();
      } else {
        if (!bankId || !typeId) throw new Error("缺少题库或题型参数");
        const created = await api.questions.create(bankId, {
          questionTypeId: typeId,
          answerMode,
          choiceVariant: answerMode === "choice" ? "single" : undefined,
          stem: stem.trim(),
          analysis,
          status: "draft",
          options:
            answerMode === "choice"
              ? options.map((item, index) => ({
                  label: item.option_label,
                  content: item.content,
                  sortOrder: index + 1,
                  isCorrect: answer.split(/[,，]/).includes(item.option_label),
                }))
              : [],
          answerPayload: answerPayload(answerMode, answer),
        });
        await Taro.redirectTo({
          url: `/packages/content/questions/detail/index?id=${created.id}`,
        });
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const pendingMedia = id
    ? pendingTransfers.mediaFor(transferScope, id)
    : undefined;
  const abandonUpload = async () => {
    if (
      pendingMedia &&
      (await confirmDanger(
        "放弃本地媒体恢复",
        "仅结束本地恢复，不会取消上传或删除服务端媒体。核对服务端结果后才开始新操作。",
        "放弃",
      ))
    ) {
      pendingTransfers.endMedia(pendingMedia);
      setMessage("本地恢复已结束，可选择新文件。");
    }
  };
  const upload = async () => {
    setUploading(true);
    try {
      if (!id) {
        setMessage("请先保存题目，再上传媒体");
        return;
      }
      let pending = pendingTransfers.mediaFor(transferScope, id);
      if (!pending) {
        const chosen = await Taro.chooseMessageFile({ count: 1, type: "all" });
        if (!chosen.tempFiles.length) return;
        const file = await identifyTransferFile(
          chosen.tempFiles[0].path,
          chosen.tempFiles[0].name,
        );
        pending = pendingTransfers.beginMedia(transferScope, id, file);
      }
      await pendingTransfers.runMedia(api, pending, verifyTransferFile);
      setMessage("媒体已上传并关联");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };
  return (
    <Page>
      <PageHeader
        eyebrow="题目管理"
        title={id ? "编辑题目" : "添加题目"}
        subtitle="支持选择、判断、填空与简答题。"
      />
      {taskId &&
      polling.task &&
      !["succeeded", "failed", "cancelled", "timed_out"].includes(
        polling.task.status,
      ) ? (
        <View className="form-card app-row">
          <Text className="app-muted">
            AI 正在生成答案草稿：{polling.task.status}
          </Text>
          <Button
            size="small"
            onClick={() =>
              void api.aiTasks.cancel(taskId).then(() => polling.refresh())
            }
          >
            取消
          </Button>
        </View>
      ) : null}
      <Section title="题干与题型">
        <View className="form-card">
          <Field label="题型">
            <Picker
              mode="selector"
              range={types.map((item) => item.display_name)}
              onChange={(event) => {
                const next = types[Number(event.detail.value)];
                if (next) {
                  dirty.current.add("type");
                  setTypeId(next.type_id);
                  setAnswerMode(next.default_answer_mode);
                }
              }}
            >
              <View className="form-input">
                {types.find((item) => item.type_id === typeId)?.display_name ||
                  "请选择"}
              </View>
            </Picker>
          </Field>
          <Field label="题干">
            <Textarea
              className="form-textarea"
              value={stem}
              onInput={(event) => {
                dirty.current.add("stem");
                setStem(event.detail.value);
              }}
            />
          </Field>
          {answerMode === "choice" ? (
            <Field label="选项">
              {options.map((option, index) => (
                <View className="app-row" key={option.option_label}>
                  <Text className="form-label">{option.option_label}</Text>
                  <Input
                    className="form-input"
                    value={option.content}
                    onInput={(event) => {
                      dirty.current.add("options");
                      setOptions(
                        options.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, content: event.detail.value }
                            : item,
                        ),
                      );
                    }}
                  />
                </View>
              ))}
              <Button
                size="small"
                onClick={() => {
                  dirty.current.add("options");
                  setOptions([
                    ...options,
                    {
                      option_label: String.fromCharCode(65 + options.length),
                      content: "",
                    },
                  ]);
                }}
              >
                添加选项
              </Button>
            </Field>
          ) : null}
          <Field label="答案">
            <Input
              className="form-input"
              value={answer}
              placeholder={
                answerMode === "choice" ? "如 A 或 A,B" : "填写参考答案"
              }
              onInput={(event) => setAnswer(event.detail.value)}
            />
          </Field>
          <Field label="解析">
            <Textarea
              className="form-textarea"
              value={analysis}
              onInput={(event) => {
                dirty.current.add("analysis");
                setAnalysis(event.detail.value);
              }}
            />
          </Field>
          {message ? <ErrorNotice>{message}</ErrorNotice> : null}
          <View className="button-row">
            <Button
              color="primary"
              shape="round"
              loading={saving}
              onClick={() => void save()}
            >
              保存
            </Button>
            <Button
              loading={uploading}
              disabled={uploading}
              onClick={() => void upload()}
            >
              {pendingMedia ? "继续原媒体操作" : "上传媒体"}
            </Button>
            {pendingMedia ? (
              <Button disabled={uploading} onClick={() => void abandonUpload()}>
                放弃本地媒体恢复
              </Button>
            ) : null}
          </View>
        </View>
      </Section>
    </Page>
  );
}
function Field({
  label,
  children,
}: React.PropsWithChildren<{ label: string }>): JSX.Element {
  return (
    <View className="form-field">
      <Text className="form-label">{label}</Text>
      {children}
    </View>
  );
}
function answerPayload(
  mode: AnswerMode,
  value: string,
): Record<string, unknown> {
  if (mode === "choice")
    return {
      correct: value
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    };
  if (mode === "true_false")
    return {
      value: ["true", "正确", "对", "1"].includes(value.trim().toLowerCase()),
    };
  return {
    answers: value
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

export default protectedPage(QuestionEditPage);
