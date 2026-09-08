import { Button, Switch } from "@taroify/core";
import { Input, Picker, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { api } from "../../../api";
import { errorMessage } from "../../../api/message";
import { ErrorNotice, Page, PageHeader, Section } from "../../../components/ui";
import { routeNumber } from "../../../navigation";

const MODES = [{ value: "all", label: "顺序练习" }, { value: "wrong", label: "错题复习" }, { value: "exam", label: "考试模式" }];
export default function PracticeSetupPage(): JSX.Element {
  const bankId = routeNumber("bankId"); const [mode, setMode] = useState("all"); const [count, setCount] = useState("20"); const [all, setAll] = useState(false); const [message, setMessage] = useState(""); const [loading, setLoading] = useState(false);
  const start = async () => { if (!bankId) { setMessage("题库参数无效"); return; } setLoading(true); setMessage(""); try { const session = await api.practice.start({ bankId, mode, sessionType: mode === "exam" ? "exam" : "practice", questionCount: all ? undefined : Math.max(1, Number(count) || 20), allQuestions: all }); await Taro.redirectTo({ url: `/packages/practice/session/index?id=${session.id}` }); } catch (error) { setMessage(errorMessage(error)); } finally { setLoading(false); } };
  return <Page><PageHeader eyebrow="练习设置" title="准备开始" subtitle="考试模式在交卷前不会显示答案与即时判定。" /><Section title="练习范围"><View className="form-card"><View className="form-field"><Text className="form-label">模式</Text><Picker mode="selector" range={MODES.map((item) => item.label)} onChange={(event) => setMode(MODES[Number(event.detail.value)]?.value || "all")}><View className="form-input">{MODES.find((item) => item.value === mode)?.label}</View></Picker></View><View className="form-field app-row"><Text className="form-label">全部可用题目</Text><Switch checked={all} onChange={setAll} /></View>{!all ? <View className="form-field"><Text className="form-label">题目数量</Text><Input className="form-input app-number" type="number" value={count} onInput={(event) => setCount(event.detail.value)} /></View> : null}{message ? <ErrorNotice>{message}</ErrorNotice> : null}<Button color="primary" block shape="round" loading={loading} onClick={() => void start()}>开始练习</Button></View></Section></Page>;
}
