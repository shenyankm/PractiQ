import { Button } from "@taroify/core";
import { Picker, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { api } from "../../../../api";
import type { BankRecord } from "../../../../api/modules";
import { errorMessage } from "../../../../api/message";
import { ErrorNotice, Page, PageHeader, Section } from "../../../../components/ui";

export default function ImportCreatePage(): JSX.Element {
  const [banks, setBanks] = useState<BankRecord[]>([]); const [bankId, setBankId] = useState<number | null>(null); const [file, setFile] = useState<{ path: string; name: string } | null>(null); const [message, setMessage] = useState(""); const [loading, setLoading] = useState(false);
  Taro.useDidShow(() => { void api.banks.list({ scope: "mine", limit: 100 }).then((page) => { setBanks(page.items); if (!bankId && page.items.length) setBankId(page.items[0].id); }).catch((error) => setMessage(errorMessage(error))); });
  const choose = async () => { try { const result = await Taro.chooseMessageFile({ count: 1, type: "all" }); const chosen = result.tempFiles[0]; if (chosen) setFile({ path: chosen.path, name: chosen.name }); } catch (error) { setMessage(errorMessage(error)); } };
  const create = async () => { if (!bankId || !file) { setMessage("请选择题库和文件"); return; } setLoading(true); setMessage(""); try { let job = await api.imports.create({ bankId, fileName: file.name, sourceType: extension(file.name), requestPayload: {} }); job = await api.imports.upload(job.id, file.path); job = await api.imports.action(job.id, "parse", { persistQuestions: true }); await Taro.redirectTo({ url: `/packages/tools/imports/detail/index?id=${job.id}` }); } catch (error) { setMessage(errorMessage(error)); } finally { setLoading(false); } };
  return <Page><PageHeader eyebrow="AI 导入" title="上传题目文件" subtitle="文件会进入持久化队列，解析完成后自动写入所选题库。" /><Section title="导入信息"><View className="form-card"><View className="form-field"><Text className="form-label">目标题库</Text><Picker mode="selector" range={banks.map((bank) => bank.name)} onChange={(event) => setBankId(banks[Number(event.detail.value)]?.id || null)}><View className="form-input">{banks.find((bank) => bank.id === bankId)?.name || "请选择"}</View></Picker></View><View className="form-field"><Text className="form-label">文件</Text><Button onClick={() => void choose()}>{file?.name || "选择文件"}</Button></View>{message ? <ErrorNotice>{message}</ErrorNotice> : null}<Button color="primary" block shape="round" loading={loading} onClick={() => void create()}>上传并开始解析</Button></View></Section></Page>;
}
function extension(name: string): string { return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "unknown"; }
