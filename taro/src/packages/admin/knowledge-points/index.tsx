import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../auth/protected-page";
import { Button } from "@taroify/core";
import { Input, Picker, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useRef, useState } from "react";
import { isRetryableWriteError } from "../../../api/client";
import type { KnowledgePoint, Subject } from "../../../api/modules";
import { errorMessage } from "../../../api/message";
import { sessionStore } from "../../../auth/session";
import {
  EntityCard,
  ErrorNotice,
  Page,
  PageHeader,
  PermissionGate,
  Section,
  StateView,
  confirmDanger,
} from "../../../components/ui";

function KnowledgePointsPage(): JSX.Element {
  const api = usePageApi();
  const pendingCsv = useRef<string | null>(null);
  const allowed = sessionStore.getSnapshot()?.user.role === "admin";
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subject, setSubject] = useState("");
  const [items, setItems] = useState<KnowledgePoint[] | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const load = async (value = subject) => {
    if (!value) return;
    try {
      setItems(
        (await api.references.knowledge({ subject: value, limit: 200 })).items,
      );
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  usePageLoad(async () => {
    if (!allowed) return;
    await api.references
      .subjects()
      .then((values) => {
        setSubjects(values);
        const first = subject || values[0]?.subject_id || "";
        setSubject(first);
        return load(first);
      })
      .catch((error) => setMessage(errorMessage(error)));
  });
  const create = async () => {
    try {
      await api.admin.knowledgeCreate({
        subjectId: subject,
        code: code.trim(),
        displayName: name.trim(),
      });
      setCode("");
      setName("");
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  const remove = async (id: number) => {
    if (
      !(await confirmDanger(
        "删除知识点",
        "已被题目或子节点使用时服务端会拒绝删除。",
        "删除",
      ))
    )
      return;
    try {
      await api.admin.knowledgeDelete(id);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  const importCsv = async () => {
    try {
      if (!pendingCsv.current) {
        const chosen = await Taro.chooseMessageFile({
          count: 1,
          type: "file",
          extension: ["csv"],
        });
        pendingCsv.current = chosen.tempFiles[0]?.path ?? null;
      }
      if (pendingCsv.current) {
        const result = await api.admin.knowledgeImport(pendingCsv.current);
        pendingCsv.current = null;
        await Taro.showToast({
          title: `导入 ${result.imported} 条`,
          icon: "success",
        });
        await load();
      }
    } catch (error) {
      if (!isRetryableWriteError(error)) pendingCsv.current = null;
      setMessage(errorMessage(error));
    }
  };
  return (
    <PermissionGate allowed={allowed}>
      <Page>
        <PageHeader
          eyebrow="管理员"
          title="知识点管理"
          subtitle="CSV 字段固定为 subjectId,code,displayName,parentCode。"
          action={
            <Button size="small" onClick={() => void importCsv()}>
              导入 CSV
            </Button>
          }
        />
        <Section title="新增知识点">
          <View className="form-card">
            <View className="form-field">
              <Text className="form-label">学科</Text>
              <Picker
                mode="selector"
                range={subjects.map((item) => item.display_name)}
                onChange={(event) => {
                  const value =
                    subjects[Number(event.detail.value)]?.subject_id || "";
                  setSubject(value);
                  void load(value);
                }}
              >
                <View className="form-input">
                  {subjects.find((item) => item.subject_id === subject)
                    ?.display_name || "请选择"}
                </View>
              </Picker>
            </View>
            <Input
              className="form-input"
              placeholder="code"
              value={code}
              onInput={(event) => setCode(event.detail.value)}
            />
            <Input
              className="form-input"
              placeholder="显示名称"
              value={name}
              onInput={(event) => setName(event.detail.value)}
            />
            {message ? <ErrorNotice>{message}</ErrorNotice> : null}
            <Button color="primary" block onClick={() => void create()}>
              新增
            </Button>
          </View>
        </Section>
        {items ? (
          <View className="list-stack">
            {items.map((item) => (
              <EntityCard
                key={item.id}
                title={item.display_name}
                meta={item.code}
                footer={
                  <Button
                    size="small"
                    color="danger"
                    variant="outlined"
                    onClick={() => void remove(item.id)}
                  >
                    删除
                  </Button>
                }
              />
            ))}
          </View>
        ) : (
          <StateView
            phase="loading"
            title="正在读取知识点"
            detail="马上就好。"
          />
        )}
      </Page>
    </PermissionGate>
  );
}

export default protectedPage(KnowledgePointsPage);
