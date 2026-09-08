import { Button } from "@taroify/core";
import { Text, View } from "@tarojs/components";
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from "@tarojs/taro";
import { useCallback, useReducer, useRef } from "react";
import { apiClient } from "../../api";
import type { BankScope } from "../../api/contracts";
import { errorMessage } from "../../api/message";
import { requiresLogin } from "../../auth/guard";
import { sessionStore } from "../../auth/session";
import { EntityCard, Page, PageHeader, StateView, StatusTag } from "../../components/ui";
import { openPage } from "../../navigation";
import { initialBankState, reduceBankList, type BankRequestMode } from "./model";
import "./index.css";

export default function BanksPage(): JSX.Element {
  const [state, dispatch] = useReducer(reduceBankList, initialBankState); const requestId = useRef(0);
  const load = useCallback(async (scope: BankScope, mode: BankRequestMode, cursor = "") => { if (requiresLogin(sessionStore.getSnapshot())) { void Taro.reLaunch({ url: "/pages/login/index" }); return; } const current = ++requestId.current; dispatch({ type: "begin", scope, mode, requestId: current }); try { const result = await apiClient.getBanks(scope, cursor, 30); dispatch({ type: "success", scope, mode, requestId: current, items: result.items, pagination: result.pagination }); } catch (error) { if (sessionStore.getSnapshot()) dispatch({ type: "failure", scope, requestId: current, message: errorMessage(error) }); } }, []);
  useDidShow(() => { void load(state.scope, "replace"); }); usePullDownRefresh(() => { void load(state.scope, "replace").finally(() => void Taro.stopPullDownRefresh()); }); useReachBottom(() => { if (state.hasMore && state.phase === "ready") void load(state.scope, "append", state.cursor); });
  return <Page tab><PageHeader eyebrow="题库" title="选择下一份练习" subtitle="整理自己的题库，也可以继续已收藏的公开题库。" action={<Button color="primary" size="small" shape="round" onClick={() => void openPage("/packages/content/banks/edit/index")}>新建</Button>} />
    <View className="scope-switch" aria-label="题库范围"><Button className={`scope-button ${state.scope === "mine" ? "scope-button-active" : ""}`} onClick={() => state.scope !== "mine" && void load("mine", "replace")}>我的题库</Button><Button className={`scope-button ${state.scope === "favorites" ? "scope-button-active" : ""}`} onClick={() => state.scope !== "favorites" && void load("favorites", "replace")}>我的收藏</Button></View>
    {(state.phase === "loading" || state.phase === "idle") && !state.items.length ? <StateView phase="loading" title="正在读取题库" detail="列表很快就会出现。" /> : null}
    {state.phase === "error" && !state.items.length ? <StateView phase="error" title="题库加载失败" detail={state.error || "请检查网络后重试。"} actionLabel="重新加载" onAction={() => void load(state.scope, "replace")} /> : null}
    {state.phase === "ready" && !state.items.length ? <StateView phase="empty" title={state.scope === "mine" ? "还没有自己的题库" : "还没有收藏题库"} detail={state.scope === "mine" ? "新建一份题库，添加第一道题。" : "公开题库详情页可以加入收藏。"} /> : null}
    <View className="list-stack">{state.items.map((bank) => <EntityCard key={bank.id} title={bank.name} meta={`${bank.subject_id} · ${bank.is_owner ? "本人创建" : "他人题库"}`} description={bank.description} badge={<StatusTag tone={bank.status === "public" ? "success" : bank.status === "banned" ? "danger" : "neutral"}>{bank.status === "public" ? "公开" : bank.status === "banned" ? "已封禁" : "私有"}</StatusTag>} onClick={() => void openPage("/packages/content/banks/detail/index", { id: bank.id })} />)}</View>
    {state.items.length ? <Text className="pagination-note">{state.phase === "loadingMore" ? "正在加载更多…" : state.hasMore ? "继续上拉加载更多" : "已显示全部题库"}</Text> : null}
  </Page>;
}
