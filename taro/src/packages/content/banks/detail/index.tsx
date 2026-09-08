import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../../auth/protected-page";
import { Button } from "@taroify/core";
import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useState } from "react";
import type { BankItem, BankRecord, Subset } from "../../../../api/modules";
import { errorMessage } from "../../../../api/message";
import {
  EntityCard,
  ErrorNotice,
  Page,
  PageHeader,
  Section,
  StateView,
  StatusTag,
  confirmDanger,
} from "../../../../components/ui";
import { openPage, routeNumber } from "../../../../navigation";

function BankDetailPage(): JSX.Element {
  const api = usePageApi();
  const id = routeNumber("id");
  const [bank, setBank] = useState<BankRecord | null>(null);
  const [items, setItems] = useState<BankItem[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [subsets, setSubsets] = useState<Subset[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!id) {
      setMessage("题库参数无效");
      setLoading(false);
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const next = await api.banks.get(id);
      setBank(next);
      const [questionPage, nextTags, nextSubsets] = await Promise.all([
        api.banks.items(id, { limit: 100, includeAnswers: false }),
        api.banks.tags(id),
        api.banks.subsets(id),
      ]);
      setItems(questionPage.items);
      setTags(nextTags);
      setSubsets(nextSubsets);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [id]);
  usePageLoad(async () => {
    await load();
  });
  if (loading && !bank)
    return (
      <Page>
        <StateView
          phase="loading"
          title="正在读取题库"
          detail="题目与目录马上就好。"
        />
      </Page>
    );
  if (!bank)
    return (
      <Page>
        <StateView
          phase="error"
          title="无法打开题库"
          detail={message || "题库不存在或无权访问。"}
          actionLabel="重试"
          onAction={() => void load()}
        />
      </Page>
    );
  const favorite = async () => {
    try {
      await api.banks.favorite(bank.id, !bank.is_favorite);
      setBank({ ...bank, is_favorite: !bank.is_favorite });
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  const remove = async () => {
    if (
      await confirmDanger(
        "删除题库",
        "题库及关联内容将不可恢复，确定继续吗？",
        "删除",
      )
    ) {
      try {
        await api.banks.remove(bank.id);
        await Taro.navigateBack();
      } catch (error) {
        setMessage(errorMessage(error));
      }
    }
  };
  return (
    <Page>
      <PageHeader
        eyebrow={bank.subject_id}
        title={bank.name}
        subtitle={bank.description || "暂无题库说明"}
        action={
          <StatusTag tone={bank.status === "public" ? "success" : "neutral"}>
            {bank.status === "public" ? "公开" : "私有"}
          </StatusTag>
        }
      />
      {message ? <ErrorNotice>{message}</ErrorNotice> : null}
      <View className="button-row">
        <Button
          color="primary"
          shape="round"
          onClick={() =>
            void openPage("/packages/practice/setup/index", { bankId: bank.id })
          }
        >
          开始练习
        </Button>
        {bank.is_owner ? (
          <Button
            onClick={() =>
              void openPage("/packages/content/banks/edit/index", {
                id: bank.id,
              })
            }
          >
            编辑
          </Button>
        ) : (
          <Button onClick={() => void favorite()}>
            {bank.is_favorite ? "取消收藏" : "收藏"}
          </Button>
        )}
        {!bank.is_owner && bank.status === "public" ? (
          <Button
            onClick={() =>
              void api.banks
                .clone(bank.id)
                .then((copy) =>
                  openPage("/packages/content/banks/detail/index", {
                    id: copy.id,
                  }),
                )
                .catch((error) => setMessage(errorMessage(error)))
            }
          >
            克隆
          </Button>
        ) : null}
        <Button
          onClick={() =>
            void openPage("/packages/tools/analytics/bank/index", {
              id: bank.id,
            })
          }
        >
          分析
        </Button>
      </View>
      <Section
        title="标签与目录"
        description={`${tags.length} 个标签 · ${subsets.length} 个目录节点`}
      >
        <View className="form-card app-stack">
          <Text>{tags.length ? tags.join(" · ") : "暂无标签"}</Text>
          {subsets.map((subset) => (
            <Text key={subset.id} className="app-muted">
              {subset.parent_id ? "　└ " : "• "}
              {subset.name}
            </Text>
          ))}
        </View>
      </Section>
      <Section
        title={`题目（${items.length}）`}
        action={
          bank.is_owner ? (
            <Button
              size="small"
              onClick={() =>
                void openPage("/packages/content/questions/edit/index", {
                  bankId: bank.id,
                })
              }
            >
              添加题目
            </Button>
          ) : null
        }
      >
        <View className="list-stack">
          {items.length ? (
            items.map((item) => (
              <EntityCard
                key={item.question_id}
                title={item.stem}
                meta={`${item.question_type_id} · ${item.answer_mode}`}
                badge={
                  <StatusTag
                    tone={
                      item.question_status === "active" ? "success" : "warning"
                    }
                  >
                    {item.question_status}
                  </StatusTag>
                }
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
              title="题库还是空的"
              detail={
                bank.is_owner
                  ? "添加第一道题，或从文件批量导入。"
                  : "题库暂时没有可练习内容。"
              }
            />
          )}
        </View>
      </Section>
      {bank.is_owner ? (
        <Section title="危险操作">
          <View className="button-row">
            <Button
              color="danger"
              variant="outlined"
              onClick={() =>
                void api.banks
                  .resetPractice(bank.id)
                  .then(() =>
                    Taro.showToast({
                      title: "练习数据已重置",
                      icon: "success",
                    }),
                  )
                  .catch((error) => setMessage(errorMessage(error)))
              }
            >
              重置练习数据
            </Button>
            <Button color="danger" onClick={() => void remove()}>
              删除题库
            </Button>
          </View>
        </Section>
      ) : null}
    </Page>
  );
}

export default protectedPage(BankDetailPage);
