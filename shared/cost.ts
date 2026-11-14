import type { DesktopCostPreferences } from "../app/src/contracts.generated";

export const costMoneyFields = ["taskLimitMicros", "dailyLimitMicros", "inputMicrosPerMillion", "outputMicrosPerMillion", "tencentMicrosPerPage"] as const;
type MoneyField = typeof costMoneyFields[number];
export type CostDraft = { enabled: boolean; currency: string } & Record<MoneyField, string>;
export function formatMicros(value: number): string { const n = BigInt(value), fraction = (n % 1000000n).toString().padStart(6, "0").replace(/0+$/, ""); return `${n / 1000000n}${fraction ? `.${fraction}` : ""}`; }
export function parseMicros(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) || value.length > 24) throw Object.assign(new Error("Invalid cost amount"), { code: "COST_PRICING_INVALID" });
  const [whole, fraction = ""] = value.split("."), amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error("Cost amount exceeds its limit"), { code: "COST_PRICING_INVALID" }); return Number(amount);
}
export function costDraft(value?: DesktopCostPreferences): CostDraft { return { enabled: value?.enabled ?? false, currency: value?.currency ?? "", ...Object.fromEntries(costMoneyFields.map(key => [key, value?.[key] == null ? "" : formatMicros(value[key])])) } as CostDraft; }
export function costPreferences(value: CostDraft): DesktopCostPreferences { return { enabled: value.enabled, currency: value.currency, ...Object.fromEntries(costMoneyFields.map(key => [key, parseMicros(value[key])])) } as DesktopCostPreferences; }
