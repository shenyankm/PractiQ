import { protectedPage, usePageLoad, usePageApi, usePageClient } from "../../auth/protected-page";
import { Button } from "@taroify/core";
import { Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import type { CapabilitySet } from "../../api/modules";
import { errorMessage } from "../../api/message";
import { sessionStore } from "../../auth/session";
import { BrandMark, ErrorNotice, MetricCard, Page, PageHeader, Section, confirmDanger } from "../../components/ui";
import { openPage } from "../../navigation";
import { pendingPaymentOrder, recoverPayment, startPayment } from "../../payments/runtime";

function ProfilePage(): JSX.Element {
  const api = usePageApi();
  const apiClient = usePageClient();
  const snapshot = sessionStore.getSnapshot(); const [name, setName] = useState(snapshot?.user.displayName ?? ""); const [capabilities, setCapabilities] = useState<CapabilitySet | null>(null); const [message, setMessage] = useState(""); const [saving, setSaving] = useState(false);
  usePageLoad(async () => { await api.capabilities().then(setCapabilities).catch(() => setCapabilities(null)); });
  if (!snapshot) { void Taro.reLaunch({ url: "/pages/login/index" }); return <Page />; }
  const user = snapshot.user;
  const save = async () => { setSaving(true); setMessage(""); try { const next = await api.auth.updateProfile({ displayName: name }); sessionStore.updateUser(next); setMessage("资料已保存"); } catch (error) { setMessage(errorMessage(error)); } finally { setSaving(false); } };
  const logout = async () => { if (await confirmDanger("退出登录", "将清除内存中的登录状态，并清除当前账号全部本地业务缓存和待恢复支付状态。", "退出")) await apiClient.logout(); };
  const pay = async (kind: "pro" | "credits") => { setMessage(""); try { const intent = await startPayment(kind); setMessage(intent.order.status === "paid" ? "支付成功，权益已更新" : `订单状态：${intent.order.status}`); const next = await api.auth.me(); sessionStore.updateUser(next); } catch (error) { setMessage(errorMessage(error)); } };
  const recover = async () => { try { const intent = await recoverPayment(); setMessage(`订单状态：${intent.order.status}`); const next = await api.auth.me(); sessionStore.updateUser(next); } catch (error) { setMessage(errorMessage(error)); } };
  return <Page tab><PageHeader eyebrow="我的" title={user.displayName || "PractiQ 学习者"} subtitle={`${user.effectiveMembership === "pro" ? "Pro 会员" : "基础会员"} · ${user.role === "admin" ? "管理员" : "普通用户"}`} action={<BrandMark compact />} /><View className="stat-grid"><MetricCard label="Credits" value={String(user.creditBalance)} /><MetricCard label="会员" value={user.paidPro ? "Pro" : "Free"} tone={user.paidPro ? "success" : "primary"} /></View>
    <Section title="个人资料"><View className="form-card"><View className="form-field"><Text className="form-label">显示名称</Text><Input className="form-input" maxlength={64} value={name} onInput={(event) => setName(event.detail.value)} /></View>{message ? <ErrorNotice>{message}</ErrorNotice> : null}<Button color="primary" block shape="round" loading={saving} onClick={() => void save()}>保存资料</Button></View></Section>
    <Section title="学习工具"><View className="nav-grid"><Nav title="学习分析" path="/packages/tools/analytics/index" /><Nav title="导入任务" path="/packages/tools/imports/index" /><Nav title="学习小组" path="/packages/groups/index" /><Nav title="缓存管理" path="/packages/tools/settings/storage/index" /></View></Section>
    <Section title="会员与 Credits"><View className="form-card app-stack"><Text className="app-muted">{capabilities?.wechatPay ? "可通过微信支付升级会员或购买 Credits。" : "当前未配置微信商户参数，购买功能暂不可用。"}</Text><Button color="primary" shape="round" block disabled={!capabilities?.wechatPay || user.paidPro} onClick={() => void pay("pro")}>升级 Pro</Button><Button shape="round" block disabled={!capabilities?.wechatPay || !user.paidPro} onClick={() => void pay("credits")}>购买 100 Credits</Button>{pendingPaymentOrder() ? <Button variant="outlined" onClick={() => void recover()}>恢复支付结果</Button> : null}</View></Section>
    {user.role === "admin" ? <Section title="管理控制台"><View className="nav-grid"><Nav title="用户管理" path="/packages/admin/users/index" /><Nav title="知识点" path="/packages/admin/knowledge-points/index" /><Nav title="订单与退款" path="/packages/admin/payments/index" /></View></Section> : null}
    <Section title="账号与隐私"><View className="button-row"><Button onClick={() => void Taro.navigateTo({ url: "/pages/privacy/index" })}>隐私政策</Button><Button color="danger" variant="outlined" onClick={() => void logout()}>退出登录</Button></View></Section></Page>;
}
function Nav({ title, path }: { title: string; path: string }): JSX.Element { return <View className="nav-card" role="button" onClick={() => void openPage(path)}><Text className="nav-card-title">{title}</Text><Text className="nav-card-detail">进入查看与管理</Text></View>; }

export default protectedPage(ProfilePage);
