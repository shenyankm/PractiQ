import { Button } from "@taroify/core";
import { Input, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useState } from "react";
import { api } from "../../../api";
import type { AdminUser } from "../../../api/modules";
import { errorMessage } from "../../../api/message";
import { sessionStore } from "../../../auth/session";
import { EntityCard, ErrorNotice, Page, PageHeader, PermissionGate, StateView, StatusTag, confirmDanger } from "../../../components/ui";

export default function AdminUsersPage(): JSX.Element {
  const allowed = sessionStore.getSnapshot()?.user.role === "admin"; const [items, setItems] = useState<AdminUser[] | null>(null); const [query, setQuery] = useState(""); const [message, setMessage] = useState(""); const load = useCallback(async () => { try { setItems((await api.admin.users({ q: query, limit: 100 })).items); setMessage(""); } catch (error) { setMessage(errorMessage(error)); } }, [query]); Taro.useDidShow(() => { if (allowed) void load(); });
  const change = async (user: AdminUser, body: unknown, prompt: string) => { if (!(await confirmDanger("确认用户变更", prompt, "确认"))) return; try { await api.admin.updateUser(user.id, body); await load(); } catch (error) { setMessage(errorMessage(error)); } };
  return <PermissionGate allowed={allowed}><Page><PageHeader eyebrow="管理员" title="用户管理" subtitle="最后一个 active 管理员不能被停用或降级。" /><View className="form-card app-stack"><Input className="form-input" placeholder="搜索用户名称" value={query} onInput={(event) => setQuery(event.detail.value)} /><Button color="primary" onClick={() => void load()}>搜索</Button>{message ? <ErrorNotice>{message}</ErrorNotice> : null}</View>{!items ? <StateView phase="loading" title="正在读取用户" detail="马上就好。" /> : <View className="list-stack">{items.map((user) => <EntityCard key={user.id} title={user.displayName || `用户 #${user.id}`} meta={`${user.role} · ${user.effectiveMembership}`} badge={<StatusTag tone={user.status === "active" ? "success" : "danger"}>{user.status}</StatusTag>} footer={<View className="button-row"><Button size="small" onClick={() => void change(user, { status: user.status === "active" ? "inactive" : "active" }, `${user.status === "active" ? "停用" : "启用"}该用户？`)}>{user.status === "active" ? "停用" : "启用"}</Button><Button size="small" onClick={() => void change(user, { role: user.role === "admin" ? "user" : "admin" }, `将用户角色改为 ${user.role === "admin" ? "普通用户" : "管理员"}？`)}>切换角色</Button></View>} />)}</View>}</Page></PermissionGate>;
}
