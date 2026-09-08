import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../../auth/protected-page";
import { Button } from "@taroify/core";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useState } from "react";
import type { QuestionRecord } from "../../../../api/modules";
import { errorMessage } from "../../../../api/message";
import { QuestionContent } from "../../../../components/QuestionContent";
import {
  ErrorNotice,
  Page,
  PageHeader,
  Section,
  StateView,
  StatusTag,
  confirmDanger,
} from "../../../../components/ui";
import { openPage, routeNumber } from "../../../../navigation";

function QuestionDetailPage(): JSX.Element {
  const api = usePageApi();
  const id = routeNumber("id");
  const [question, setQuestion] = useState<QuestionRecord | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!id) {
      setMessage("题目参数无效");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setQuestion(await api.questions.get(id));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [id]);
  usePageLoad(async () => {
    await load();
  });
  if (loading && !question)
    return (
      <Page>
        <StateView
          phase="loading"
          title="正在读取题目"
          detail="内容马上就好。"
        />
      </Page>
    );
  if (!question)
    return (
      <Page>
        <StateView
          phase="error"
          title="无法打开题目"
          detail={message}
          actionLabel="重试"
          onAction={() => void load()}
        />
      </Page>
    );
  const remove = async () => {
    if (
      await confirmDanger(
        "删除题目",
        "题目及答案版本将不可恢复，确定继续吗？",
        "删除",
      )
    ) {
      try {
        await api.questions.remove(question.id);
        await Taro.navigateBack();
      } catch (error) {
        setMessage(errorMessage(error));
      }
    }
  };
  return (
    <Page>
      <PageHeader
        eyebrow={question.question_type_id}
        title="题目详情"
        subtitle={`${question.answer_mode}${question.choice_variant ? ` · ${question.choice_variant}` : ""}`}
        action={
          <StatusTag
            tone={question.status === "active" ? "success" : "warning"}
          >
            {question.status}
          </StatusTag>
        }
      />
      {message ? <ErrorNotice>{message}</ErrorNotice> : null}
      <Section title="题目内容">
        <View className="form-card">
          <QuestionContent question={question} revealAnswer={false} />
        </View>
      </Section>
      {question.can_edit ? (
        <Section title="内容管理">
          <View className="button-row">
            <Button
              color="primary"
              onClick={() =>
                void openPage("/packages/content/questions/edit/index", {
                  id: question.id,
                })
              }
            >
              编辑
            </Button>
            <Button
              onClick={() =>
                void (
                  question.status === "active"
                    ? api.questions.archive(question.id)
                    : api.questions.publish(question.id)
                )
                  .then(load)
                  .catch((error) => setMessage(errorMessage(error)))
              }
            >
              {question.status === "active" ? "归档" : "发布"}
            </Button>
            <Button
              onClick={() =>
                void api.questions
                  .aiAnswer(question.id)
                  .then((task) =>
                    openPage("/packages/content/questions/edit/index", {
                      id: question.id,
                      taskId: task.id,
                    }),
                  )
                  .catch((error) => setMessage(errorMessage(error)))
              }
            >
              AI 生成答案草稿
            </Button>
            <Button
              color="danger"
              variant="outlined"
              onClick={() => void remove()}
            >
              删除
            </Button>
          </View>
        </Section>
      ) : null}
    </Page>
  );
}

export default protectedPage(QuestionDetailPage);
