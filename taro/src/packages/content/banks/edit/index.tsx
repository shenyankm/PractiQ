import {
  protectedPage,
  usePageLoad,
  usePageApi,
} from "../../../../auth/protected-page";
import { Button, Switch } from "@taroify/core";
import { Input, Picker, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useRef, useState } from "react";
import type { Subject } from "../../../../api/modules";
import { errorMessage } from "../../../../api/message";
import {
  ErrorNotice,
  Page,
  PageHeader,
  Section,
} from "../../../../components/ui";
import { routeNumber } from "../../../../navigation";

function BankEditPage(): JSX.Element {
  const api = usePageApi();
  const createdBank = useRef<{ body: string; id: number } | null>(null);
  const dirty = useRef(new Set<string>());
  const id = routeNumber("id");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [subject, setSubject] = useState("");
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [isPublic, setPublic] = useState(false);
  const [tags, setTags] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  usePageLoad(async () => {
    if (!id && createdBank.current) await api.banks.get(createdBank.current.id);
    await api.references.subjects().then((values) => {
      setSubjects(values);
      if (!subject && values.length) setSubject(values[0].subject_id);
    });
    if (id)
      await Promise.all([api.banks.get(id), api.banks.tags(id)])
        .then(([bank, value]) => {
          if (!dirty.current.has("name")) setName(bank.name);
          if (!dirty.current.has("description"))
            setDescription(bank.description || "");
          if (!dirty.current.has("subject")) setSubject(bank.subject_id);
          if (!dirty.current.has("public") || bank.status === "public")
            setPublic(bank.status === "public");
          if (!dirty.current.has("tags")) setTags(value.join(", "));
        })
        .catch((error) => setMessage(errorMessage(error)));
  });
  const save = async () => {
    if (!name.trim() || !subject) {
      setMessage("请填写题库名称并选择学科");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const body = { name: name.trim(), description, subject, isPublic };
      const identity = JSON.stringify(body);
      let bank: { id: number };
      if (id)
        bank = await api.banks.update(id, {
          name: body.name,
          description,
          isPublic: isPublic || undefined,
        });
      else if (createdBank.current?.body === identity)
        bank = createdBank.current;
      else {
        bank = await api.banks.create(body);
        createdBank.current = { body: identity, id: bank.id };
      }
      const normalized = [
        ...new Set(
          tags
            .split(/[,，]/)
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ];
      await api.banks.replaceTags(bank.id, normalized);
      if (id) {
        await Taro.showToast({ title: "已保存", icon: "success" });
        await Taro.navigateBack();
      } else
        await Taro.redirectTo({
          url: `/packages/content/banks/detail/index?id=${bank.id}`,
        });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Page>
      <PageHeader
        eyebrow="题库管理"
        title={id ? "编辑题库" : "新建题库"}
        subtitle="名称清楚、目录简洁，后续练习会更顺手。"
      />
      <Section title="基本信息">
        <View className="form-card">
          <Field label="题库名称">
            <Input
              className="form-input"
              maxlength={100}
              value={name}
              onInput={(event) => {
                dirty.current.add("name");
                setName(event.detail.value);
              }}
            />
          </Field>
          <Field label="学科">
            <Picker
              mode="selector"
              range={subjects.map((item) => item.display_name)}
              onChange={(event) => {
                dirty.current.add("subject");
                setSubject(
                  subjects[Number(event.detail.value)]?.subject_id || subject,
                );
              }}
            >
              <View className="form-input">
                {subjects.find((item) => item.subject_id === subject)
                  ?.display_name || "请选择"}
              </View>
            </Picker>
          </Field>
          <Field label="题库说明">
            <Textarea
              className="form-textarea"
              maxlength={500}
              value={description}
              onInput={(event) => {
                dirty.current.add("description");
                setDescription(event.detail.value);
              }}
            />
          </Field>
          <Field label="标签（逗号分隔）">
            <Input
              className="form-input"
              value={tags}
              onInput={(event) => {
                dirty.current.add("tags");
                setTags(event.detail.value);
              }}
            />
          </Field>
          <View className="form-field app-row">
            <Text className="form-label">公开题库</Text>
            <Switch
              checked={isPublic}
              disabled={Boolean(id && isPublic)}
              onChange={(value) => {
                dirty.current.add("public");
                setPublic(value);
              }}
            />
          </View>
          {message ? <ErrorNotice>{message}</ErrorNotice> : null}
          <Button
            color="primary"
            shape="round"
            block
            loading={saving}
            onClick={() => void save()}
          >
            保存题库
          </Button>
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

export default protectedPage(BankEditPage);
