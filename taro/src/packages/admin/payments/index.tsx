import { Button } from "@taroify/core";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useState } from "react";
import { api } from "../../../api";
import type { PaymentOrder } from "../../../api/modules";
import { errorMessage } from "../../../api/message";
import { sessionStore } from "../../../auth/session";
import { EntityCard, ErrorNotice, Page, PageHeader, PermissionGate, StateView, StatusTag, confirmDanger } from "../../../components/ui";

export default function AdminPaymentsPage(): JSX.Element {
  const allowed = sessionStore.getSnapshot()?.user.role === "admin"; const [items, setItems] = useState<PaymentOrder[] | null>(null); const [message, setMessage] = useState(""); const load = useCallback(async () => { try { setItems(await api.payments.adminList()); } catch (error) { setMessage(errorMessage(error)); } }, []); Taro.useDidShow(() => { if (allowed) void load(); });
  const refund = async (id: number) => { if (!(await confirmDanger("发起退款", "退款将通过支付网关处理，确定继续吗？", "退款"))) return; try { await api.payments.refund(id); await load(); } catch (error) { setMessage(errorMessage(error)); } };
  return <PermissionGate allowed={allowed}><Page><PageHeader eyebrow="管理员" title="订单与退款" subtitle="生产支付未配置时仅展示已有订单，不会发起必然失败的购买。" />{message ? <ErrorNotice>{message}</ErrorNotice> : null}{!items ? <StateView phase="loading" title="正在读取订单" detail="马上就好。" /> : <View className="list-stack">{items.length ? items.map((order) => <EntityCard key={order.id} title={`订单 #${order.id}`} meta={`${order.kind} · ¥${(order.amountCents / 100).toFixed(2)}`} badge={<StatusTag tone={order.status === "paid" ? "success" : order.status === "refunded" ? "neutral" : "warning"}>{order.status}</StatusTag>} footer={order.status === "paid" ? <Button size="small" color="danger" variant="outlined" onClick={() => void refund(order.id)}>退款</Button> : null} />) : <StateView phase="empty" title="暂无订单" detail="测试网关验收产生的订单会显示在这里。" />}</View>}</Page></PermissionGate>;
}
