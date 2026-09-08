import Taro from "@tarojs/taro";
import { api } from "../api";
import type { PaymentIntent } from "../api/modules";
import { isPaymentTerminal } from "../polling";

let pendingOrderId: number | null = null;
export const pendingPaymentOrder = (): number | null => pendingOrderId;

export async function startPayment(kind: "pro" | "credits"): Promise<PaymentIntent> {
  const intent = await api.payments.create(kind); pendingOrderId = intent.order.id;
  if (!intent.requestPayment) return intent;
  await Taro.requestPayment(intent.requestPayment);
  return recoverPayment();
}

export async function recoverPayment(): Promise<PaymentIntent> {
  if (!pendingOrderId) throw new Error("当前运行中没有待恢复的支付订单");
  const deadline = Date.now() + 30_000; let intent = await api.payments.get(pendingOrderId);
  while (intent.order.status === "pending" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    intent = await api.payments.get(pendingOrderId);
  }
  if (isPaymentTerminal(intent.order.status)) pendingOrderId = null;
  return intent;
}
