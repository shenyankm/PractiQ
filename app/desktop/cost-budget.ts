import type { DesktopCostPreferences, DesktopCostReceipt, DesktopCostReport, DesktopCostTotal } from "../src/contracts.generated.js";
import { hash } from "./assets.js";
import { validateContract } from "./contracts.js";
import { AppError, invariant } from "./errors.js";
import type { SqliteStore } from "./graph-store.js";
import { canonical } from "./questions.js";

const namespace = ["practiq_cost_v1"];
export const noCost = (): DesktopCostPreferences => ({ enabled: false, currency: "", taskLimitMicros: null, dailyLimitMicros: null, inputMicrosPerMillion: null, outputMicrosPerMillion: null, tencentMicrosPerPage: null });
export function costSettings(value?: DesktopCostPreferences): DesktopCostPreferences {
  const cost = value ?? noCost(); try { validateContract("DesktopCostPreferences", cost); } catch { throw new AppError("COST_PRICING_INVALID", "Invalid bounded cost settings"); }
  invariant((cost.currency === "" || /^[A-Z]{3}$/.test(cost.currency)) && (!cost.enabled || cost.currency && [cost.inputMicrosPerMillion, cost.outputMicrosPerMillion, cost.tencentMicrosPerPage].every(value => value !== null) && (cost.taskLimitMicros !== null || cost.dailyLimitMicros !== null)), "COST_PRICING_INVALID", "Enabled cost limits require a currency, explicit prices and at least one positive limit"); return cost;
}
function safe(value: bigint): number { invariant(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), "COST_BUDGET_EXCEEDED", "Estimated cost exceeds the supported accounting range"); return Number(value); }
export function modelEstimate(bytes: number, maxOutput: number, cost: DesktopCostPreferences): number {
  invariant(Number.isSafeInteger(bytes) && bytes >= 0 && Number.isSafeInteger(maxOutput) && maxOutput > 0 && cost.inputMicrosPerMillion !== null && cost.outputMicrosPerMillion !== null, "COST_PRICING_INVALID", "Invalid model cost estimate");
  return safe((BigInt(bytes) * BigInt(cost.inputMicrosPerMillion) + BigInt(maxOutput) * BigInt(cost.outputMicrosPerMillion) + 999999n) / 1000000n);
}
export function pageEstimate(pages: number, cost: DesktopCostPreferences): number { invariant(Number.isSafeInteger(pages) && pages >= 1 && pages <= 300 && cost.tencentMicrosPerPage !== null, "COST_PRICING_INVALID", "Invalid recognition page estimate"); return safe(BigInt(pages) * BigInt(cost.tencentMicrosPerPage)); }
function total(value: Record<string, unknown> | null): DesktopCostTotal | null { if (!value) return null; validateContract("DesktopCostTotal", value); return value as DesktopCostTotal; }
function readReceipt(value: Record<string, unknown>): DesktopCostReceipt {
  validateContract("DesktopCostReceipt", value); const receipt = value as DesktopCostReceipt, date = new Date(`${receipt.day}T00:00:00.000Z`);
  invariant(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === receipt.day, "COST_STORE_UNAVAILABLE", "Retained reservation has an invalid UTC day"); return receipt;
}

/** Conservative reservations are never refunded, including failures and unknown outcomes. */
export class CostBudget {
  constructor(readonly store: SqliteStore, private readonly currentPolicy?: (required: boolean) => DesktopCostPreferences | undefined) {}
  policy(snapshot?: DesktopCostPreferences, requireSource = false): DesktopCostPreferences {
    try { return costSettings(this.currentPolicy?.(requireSource) ?? snapshot); }
    catch (error) { if (error instanceof AppError && error.code === "COST_PRICING_INVALID") throw error; throw new AppError("COST_STORE_UNAVAILABLE", "Current cost policy cannot be read; provider work remains blocked"); }
  }
  reserve(cost: DesktopCostPreferences, scope: string, callKey: string, amount: number, kind: "model" | "tencent", targetHash: string): DesktopCostReceipt | null {
    costSettings(cost); if (!cost.enabled) return null;
    invariant(/^(task|grading):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(scope) && callKey.length > 0 && callKey.length <= 512 && Number.isSafeInteger(amount) && amount >= 0, "COST_STORE_REQUIRED", "Cost admission requires a durable task and call identity");
    const day = new Date().toISOString().slice(0, 10), pricingHash = hash(canonical({ currency: cost.currency, inputMicrosPerMillion: cost.inputMicrosPerMillion, outputMicrosPerMillion: cost.outputMicrosPerMillion, tencentMicrosPerPage: cost.tencentMicrosPerPage }));
    const receipt: DesktopCostReceipt = { version: 1, currency: cost.currency, reservedMicros: amount, scope, kind, pricingHash, targetHash, day }; validateContract("DesktopCostReceipt", receipt);
    let result = receipt;
    try {
      this.store.updateManySync(namespace, [`call:${hash(`${scope}/${callKey}`)}`, `scope:${scope}`, `day:${day}`], ([previous, task, daily]) => {
        if (previous) {
          readReceipt(previous); const { day: _day, ...saved } = previous, { day: _today, ...expected } = receipt;
          invariant(canonical(saved) === canonical(expected), "COST_RESERVATION_CONFLICT", "Retained cost reservation belongs to another price, target or amount"); result = previous as DesktopCostReceipt; return null;
        }
        const totals = [total(task), total(daily)], limits = [cost.taskLimitMicros, cost.dailyLimitMicros];
        return [{ ...receipt }, ...totals.map((item, index) => {
          invariant(!item || item.currency === cost.currency, "COST_CURRENCY_CONFLICT", "Retained budget uses another currency");
          const reservedMicros = safe(BigInt(item?.reservedMicros ?? 0) + BigInt(amount)); invariant(limits[index] === null || reservedMicros <= limits[index]!, "COST_BUDGET_EXCEEDED", "Estimated cost limit exhausted; inspect reservations before explicit retry"); return { currency: cost.currency, reservedMicros };
        })];
      });
    } catch (error) { if (error instanceof AppError && error.code.startsWith("COST_")) throw error; throw new AppError("COST_STORE_UNAVAILABLE", "Cost reservation could not be persisted; no provider request was authorized"); }
    return result;
  }
  async report(value?: DesktopCostPreferences, threadId?: string): Promise<DesktopCostReport> {
    const cost = this.policy(value), utcDay = new Date().toISOString().slice(0, 10);
    if (threadId) invariant(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(threadId), "LOCAL_FILTER_INVALID", "Invalid cost scope");
    try {
      const day = total(this.store.read(namespace, `day:${utcDay}`)?.value ?? null), task = threadId ? total(this.store.read(namespace, `scope:task:${threadId}`)?.value ?? null) : null;
      const rows = await this.store.search(namespace, { filter: { version: 1, ...(threadId ? { scope: `task:${threadId}` } : {}) }, limit: 20 });
      const recent = rows.map(row => readReceipt(row.value));
      const report = { enabled: cost.enabled, currency: cost.currency, utcDay, day, task, taskLimitMicros: cost.taskLimitMicros, dailyLimitMicros: cost.dailyLimitMicros, recent }; validateContract("DesktopCostReport", report); return report;
    } catch (error) { if (error instanceof AppError && error.code.startsWith("COST_")) throw error; throw new AppError("COST_STORE_UNAVAILABLE", "Retained cost reservations cannot be read; their values remain unchanged"); }
  }
}
