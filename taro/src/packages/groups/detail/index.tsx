import {
  protectedPage,
  usePageLoad,
  usePageApi,
  usePageVisible,
} from "../../../auth/protected-page";
import { Button } from "@taroify/core";
import { View } from "@tarojs/components";
import Taro, { useShareAppMessage } from "@tarojs/taro";
import { useCallback, useState } from "react";
import type { BankRecord, GroupMember, StudyGroup } from "../../../api/modules";
import { errorMessage } from "../../../api/message";
import {
  EntityCard,
  ErrorNotice,
  Page,
  PageHeader,
  Section,
  StateView,
  StatusTag,
  confirmDanger,
} from "../../../components/ui";
import { routeNumber } from "../../../navigation";

function StudyGroupDetailPage(): JSX.Element {
  const api = usePageApi();
  const visible = usePageVisible();
  const id = routeNumber("id");
  const [group, setGroup] = useState<StudyGroup | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [banks, setBanks] = useState<BankRecord[]>([]);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [value, people, owned] = await Promise.all([
        api.groups.get(id),
        api.groups.members(id),
        api.banks.list({ scope: "mine", limit: 100 }),
      ]);
      setGroup(value);
      setMembers(people);
      setBanks(owned.items);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, [id]);
  usePageLoad(async () => {
    await load();
  });
  useShareAppMessage(() => ({
    title: visible && group ? `加入 ${group.name}` : "加入 PractiQ 学习小组",
    path:
      visible && token
        ? `/packages/groups/join/index?token=${encodeURIComponent(token)}`
        : "/packages/groups/index",
  }));
  if (!group)
    return (
      <Page>
        <StateView
          phase={message ? "error" : "loading"}
          title={message ? "小组读取失败" : "正在读取小组"}
          detail={message || "马上就好。"}
          actionLabel={message ? "重试" : undefined}
          onAction={message ? () => void load() : undefined}
        />
      </Page>
    );
  const invite = async () => {
    if (!id) return;
    try {
      const value = await api.groups.invite(id);
      setToken(value.token);
      setMessage(
        "邀请已创建，仅本次显示；点击右上角转发给好友，7 天内单次有效。",
      );
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  const removeMember = async (userId: number) => {
    if (
      !id ||
      !(await confirmDanger(
        "移除成员",
        "移除后将立即撤销小组题库访问权限。",
        "移除",
      ))
    )
      return;
    try {
      await api.groups.removeMember(id, userId);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  const leave = async () => {
    if (
      !id ||
      !(await confirmDanger(
        group.role === "owner" ? "删除小组" : "退出小组",
        "关联权限将被立即撤销，确定继续吗？",
        "确认",
      ))
    )
      return;
    try {
      if (group.role === "owner") await api.groups.remove(id);
      else await api.groups.leave(id);
      await Taro.navigateBack();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  return (
    <Page>
      <PageHeader
        eyebrow="学习小组"
        title={group.name}
        subtitle={group.description || "暂无小组说明"}
        action={
          <StatusTag tone={group.role === "owner" ? "primary" : "neutral"}>
            {group.role === "owner" ? "组长" : "成员"}
          </StatusTag>
        }
      />
      {message ? <ErrorNotice>{message}</ErrorNotice> : null}
      {group.role === "owner" ? (
        <View className="button-row">
          <Button
            color="primary"
            openType={token ? "share" : undefined}
            onClick={() => !token && void invite()}
          >
            {token ? "转发邀请" : "创建邀请"}
          </Button>
        </View>
      ) : null}
      <Section title="成员">
        <View className="list-stack">
          {members.map((member) => (
            <EntityCard
              key={member.user_id}
              title={member.display_name || `用户 #${member.user_id}`}
              meta={member.joined_at || ""}
              badge={
                <StatusTag
                  tone={member.status === "accepted" ? "success" : "neutral"}
                >
                  {member.status}
                </StatusTag>
              }
              footer={
                group.role === "owner" &&
                member.user_id !== group.owner_user_id ? (
                  <Button
                    size="small"
                    color="danger"
                    variant="outlined"
                    onClick={() => void removeMember(member.user_id)}
                  >
                    移除
                  </Button>
                ) : null
              }
            />
          ))}
        </View>
      </Section>
      {group.role === "owner" ? (
        <Section
          title="关联本人题库"
          description="小组成员会立即获得所关联题库的访问权限。"
        >
          <View className="list-stack">
            {banks.map((bank) => (
              <EntityCard
                key={bank.id}
                title={bank.name}
                meta={bank.subject_id}
                footer={
                  <View className="button-row">
                    <Button
                      size="small"
                      onClick={() =>
                        void api.groups
                          .linkBank(group.id, bank.id, true)
                          .then(() =>
                            Taro.showToast({
                              title: "已关联",
                              icon: "success",
                            }),
                          )
                          .catch((error) => setMessage(errorMessage(error)))
                      }
                    >
                      关联
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() =>
                        void api.groups
                          .linkBank(group.id, bank.id, false)
                          .then(() =>
                            Taro.showToast({
                              title: "已取消关联",
                              icon: "success",
                            }),
                          )
                          .catch((error) => setMessage(errorMessage(error)))
                      }
                    >
                      取消关联
                    </Button>
                  </View>
                }
              />
            ))}
          </View>
        </Section>
      ) : null}
      <Section title="危险操作">
        <Button color="danger" variant="outlined" onClick={() => void leave()}>
          {group.role === "owner" ? "删除小组" : "退出小组"}
        </Button>
      </Section>
    </Page>
  );
}

export default protectedPage(StudyGroupDetailPage);
