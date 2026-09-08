import { Button } from "@taroify/core";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { api } from "../../../api";
import type { StudyGroup } from "../../../api/modules";
import { errorMessage } from "../../../api/message";
import { ErrorNotice, Page, PageHeader, StateView } from "../../../components/ui";
import { routeText } from "../../../navigation";

export default function JoinGroupPage(): JSX.Element {
  const token = routeText("token"); const [group, setGroup] = useState<StudyGroup | null>(null); const [message, setMessage] = useState(""); Taro.useDidShow(() => { if (!token) { setMessage("邀请参数无效"); return; } void api.groups.inviteInfo(token).then(setGroup).catch((error) => setMessage(errorMessage(error))); }); const respond = async (action: "accept" | "reject") => { try { const value = await api.groups.respond(token, action); if (action === "accept") await Taro.redirectTo({ url: `/packages/groups/detail/index?id=${value.id}` }); else await Taro.navigateBack(); } catch (error) { setMessage(errorMessage(error)); } };
  if (!group) return <Page><StateView phase={message ? "error" : "loading"} title={message ? "邀请不可用" : "正在验证邀请"} detail={message || "马上就好。"} /></Page>;
  return <Page><PageHeader eyebrow="小组邀请" title={group.name} subtitle={group.description || "好友邀请你加入学习小组"} />{message ? <ErrorNotice>{message}</ErrorNotice> : null}<Button color="primary" block shape="round" onClick={() => void respond("accept")}>接受邀请</Button><Button block variant="outlined" onClick={() => void respond("reject")}>拒绝</Button></Page>;
}
