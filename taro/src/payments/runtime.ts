import Taro from "@tarojs/taro";
import { api } from "../api";
import { sessionStore } from "../auth/session";
import { PaymentRecovery } from "./recovery";

const recovery = new PaymentRecovery({
  create: api.payments.create,
  get: api.payments.get,
  pay: (parameters) => Taro.requestPayment(parameters),
  now: Date.now,
  wait: () => new Promise<void>((resolve) => setTimeout(resolve, 2000)),
});
sessionStore.onReset(() => recovery.clear());
export const pendingPaymentOrder = (): number | null => recovery.orderId();
export const startPayment = (kind: "pro" | "credits") => recovery.start(kind);
export const recoverPayment = () => recovery.recover();
