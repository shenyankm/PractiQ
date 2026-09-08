import type { PaymentIntent, WechatPaymentParameters } from "../api/modules";
import { isPaymentTerminal } from "../polling";

export class PaymentRecovery {
  private pending: PaymentIntent | null = null;
  private running: Promise<PaymentIntent> | null = null;
  private revision = 0;
  constructor(private readonly actions: {
    create(kind: "pro" | "credits"): Promise<PaymentIntent>;
    get(id: number): Promise<PaymentIntent>;
    pay(parameters: WechatPaymentParameters): Promise<unknown>;
    now(): number;
    wait(): Promise<void>;
  }) {}
  clear(): void { this.revision += 1; this.pending = null; this.running = null; }
  orderId(): number | null { return this.pending?.order.id ?? null; }
  start(kind: "pro" | "credits"): Promise<PaymentIntent> {
    if (this.running) return this.running;
    const revision = this.revision;
    const run = (async () => {
      if (this.pending && this.pending.order.kind !== kind) throw new Error("请先恢复当前支付订单");
      let intent = this.pending ? await this.actions.get(this.pending.order.id) : await this.actions.create(kind);
      this.check(revision);
      if (intent.order.status === "pending" && Date.parse(intent.order.expiresAt) <= this.actions.now()) {
        intent = await this.actions.create(kind); // Java owns 30-minute lookup/close/replace semantics.
        this.check(revision);
      }
      this.pending = isPaymentTerminal(intent.order.status) ? null : intent;
      if (intent.order.status !== "pending" || !intent.requestPayment) return intent;
      await this.actions.pay(intent.requestPayment);
      this.check(revision);
      return this.recover();
    })();
    this.running = run;
    void run.finally(() => { if (this.running === run) this.running = null; }).catch(() => undefined);
    return run;
  }
  async recover(): Promise<PaymentIntent> {
    if (!this.pending) throw new Error("当前运行中没有待恢复的支付订单");
    const revision = this.revision;
    const id = this.pending.order.id;
    const deadline = this.actions.now() + 30_000;
    let intent = await this.actions.get(id);
    this.check(revision);
    while (intent.order.status === "pending" && this.actions.now() < deadline) {
      await this.actions.wait();
      this.check(revision);
      intent = await this.actions.get(id);
      this.check(revision);
    }
    this.pending = isPaymentTerminal(intent.order.status) ? null : intent;
    return intent;
  }
  private check(revision: number): void { if (revision !== this.revision) throw new Error("账号已变化，支付结果未写入当前账号"); }
}
