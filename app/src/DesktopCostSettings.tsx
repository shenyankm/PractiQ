import type { CostDraft } from "../../shared/cost";
import { costMoneyFields } from "../../shared/cost";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { t } from "./i18n";

const labels = { taskLimitMicros: "单任务费用限额", dailyLimitMicros: "UTC 每日费用限额", inputMicrosPerMillion: "模型输入价格（每百万估算 tokens）", outputMicrosPerMillion: "模型输出价格（每百万 tokens）", tencentMicrosPerPage: "腾讯识别价格（每页）" } as const;
export function DesktopCostSettings({ value, onChange }: { value: CostDraft; onChange: (value: CostDraft) => void }) {
  return <details className="py-4"><summary>{t("费用预留限制（可选）")}</summary>
    <p className="my-3 text-sm text-muted-foreground">{t("按手动填写的价格保守预留费用，不代表供应商实际账单。失败和未知调用不退款；调高限额后仍需明确继续任务。未启用期间的调用不补算费用。")}</p>
    <p className="text-sm text-muted-foreground">{t("费用预留仅覆盖模型与腾讯识别的估算，不含 COS 存储、流量等费用。")}</p>
    <label className="flex items-center gap-2 py-3"><Checkbox checked={value.enabled} onCheckedChange={checked => onChange({ ...value, enabled: checked === true })} />{t("启用费用预留限制")}</label>
    <div className="setting-row"><label htmlFor="desktop-cost-currency">{t("预算币种（三位大写代码）")}</label><Input id="desktop-cost-currency" value={value.currency} disabled={!value.enabled} required={value.enabled} maxLength={3} pattern="[A-Z]{3}" onChange={event => onChange({ ...value, currency: event.target.value.toUpperCase() })} /></div>
    {costMoneyFields.map(key => <div className="setting-row" key={key}><label htmlFor={`desktop-cost-${key}`}>{t(labels[key])}</label><Input id={`desktop-cost-${key}`} disabled={!value.enabled} required={value.enabled && !key.endsWith("LimitMicros")} inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?" maxLength={24} value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} /></div>)}
    <p className="text-sm text-muted-foreground">{t("金额最多六位小数，均使用以上币种；至少填写一个正数限额，留空表示不限制。模型输入按完整请求字节数保守估算，腾讯按已知页数或页数上限预留。")}</p>
  </details>;
}
