import { Button } from "@taroify/core";
import { Input, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useState } from "react";
import { api } from "../../api";
import type { StudyGroup } from "../../api/modules";
import { errorMessage } from "../../api/message";
import { EntityCard, ErrorNotice, Page, PageHeader, Section, StateView, StatusTag } from "../../components/ui";
import { openPage } from "../../navigation";

export default function StudyGroupsPage(): JSX.Element {
  const [items, setItems] = useState<StudyGroup[] | null>(null); const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [message, setMessage] = useState(""); const load = useCallback(async () => { try { setItems(await api.groups.list()); } catch (error) { setMessage(errorMessage(error)); } }, []); Taro.useDidShow(() => { void load(); }); const create = async () => { if (!name.trim()) { setMessage("请填写小组名称"); return; } try { const group = await api.groups.create({ name: name.trim(), description }); await openPage("/packages/groups/detail/index", { id: group.id }); } catch (error) { setMessage(errorMessage(error)); } };
  return <Page><PageHeader eyebrow="协作学习" title="学习小组" subtitle="邀请同伴、共享本人题库，并在权限范围内查看成员学情。" /><Section title="创建小组"><View className="form-card app-stack"><View className="form-field"><Text className="form-label">小组名称</Text><Input className="form-input" maxlength={100} value={name} onInput={(event) => setName(event.detail.value)} /></View><Textarea className="form-textarea" placeholder="小组说明" value={description} onInput={(event) => setDescription(event.detail.value)} />{message ? <ErrorNotice>{message}</ErrorNotice> : null}<Button color="primary" block shape="round" onClick={() => void create()}>创建小组</Button></View></Section><Section title="我的小组">{!items ? <StateView phase="loading" title="正在读取小组" detail="马上就好。" /> : <View className="list-stack">{items.length ? items.map((group) => <EntityCard key={group.id} title={group.name} description={group.description} meta={`${group.member_count || 1} 名成员 · ${group.bank_count || 0} 个题库`} badge={<StatusTag tone={group.role === "owner" ? "primary" : "neutral"}>{group.role === "owner" ? "组长" : "成员"}</StatusTag>} onClick={() => void openPage("/packages/groups/detail/index", { id: group.id })} />) : <StateView phase="empty" title="还没有学习小组" detail="创建小组，或通过好友分享的邀请加入。" />}</View>}</Section></Page>;
}
