import { t, useI18n } from "./i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowUp, ArrowDown } from "lucide-react";
import { type Question, type Answer, canInteract, itemIds } from "./api";
import { countEnglishWords } from "./english";
import { Markdown } from "./Content";
export function AnswerInput({
  question: q,
  value,
  onChange,
  disabled = false,
  prefix = "answer",
  usedOptions = [],
}: {
  question: Question;
  value: Answer | null;
  onChange: (a: Answer) => void;
  disabled?: boolean;
  prefix?: string;
  usedOptions?: string[];
}) {
  useI18n();
  const a = {
    ...value,
    matches: value?.matches?.filter(
      (p) => p && typeof p.left === "number" && typeof p.right === "number",
    ),
    order: value?.order?.filter((i) => typeof i === "number"),
  };
  if (!canInteract(q))
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("题目结构不完整，使用自由作答并自评。")}</p>
        <Textarea
          aria-label={t("自由作答")}
          disabled={disabled}
          value={a.text || ""}
          onChange={(e) => onChange({ text: e.target.value })}
          rows={5}
        />
      </div>
    );
  switch (q.answerMode) {
    case "choice":
      return q.choiceVariant === "multiple" ? (
        <fieldset disabled={disabled} className="space-y-3">
          <legend className="mb-2 text-sm text-muted-foreground">{t("多选题，可选择多个答案")}</legend>
          {q.options.map((o, i) => (
            <label
              key={i}
              htmlFor={`${prefix}-${i}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3"
            >
              <Checkbox
                className="mt-1 shrink-0"
                id={`${prefix}-${i}`}
                checked={a.correct?.includes(o.label!) || false}
                onCheckedChange={(checked) =>
                  onChange({
                    correct: checked
                      ? [...(a.correct || []), o.label!]
                      : (a.correct || []).filter((s) => s !== o.label),
                  })
                }
              />
              <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 leading-[1.75]">
                <span className="min-w-6 font-medium">{o.label}.</span>
                <Markdown>{o.content}</Markdown>
                {usedOptions.includes(o.label!) && <span className="text-xs text-muted-foreground">{t("已使用")}</span>}
              </div>
            </label>
          ))}
        </fieldset>
      ) : (
        <RadioGroup
          disabled={disabled}
          value={a.correct?.[0] || ""}
          onValueChange={(v) => onChange({ correct: [v] })}
          aria-label={t("选择答案")}
        >
          {q.options.map((o, i) => (
            <label
              key={i}
              htmlFor={`${prefix}-${i}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3"
            >
              <RadioGroupItem className="mt-1 shrink-0" id={`${prefix}-${i}`} value={o.label!} disabled={usedOptions.includes(o.label!) && !a.correct?.includes(o.label!)} />
              <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 leading-[1.75]">
                <span className="min-w-6 font-medium">{o.label}.</span>
                <Markdown>{o.content}</Markdown>
                {usedOptions.includes(o.label!) && <span className="text-xs text-muted-foreground">{t("已使用")}</span>}
              </div>
            </label>
          ))}
        </RadioGroup>
      );
    case "true_false":
      return (
        <RadioGroup
          disabled={disabled}
          value={a.value === undefined ? "" : String(a.value)}
          onValueChange={(v) => onChange({ value: v === "true" })}
          aria-label={t("判断答案")}
        >
          {[
            ["true", t("正确")],
            ["false", t("错误")],
          ].map(([v, t]) => (
            <label
              key={v}
              htmlFor={`${prefix}-${v}`}
              className="flex items-center gap-3 rounded-lg border p-4"
            >
              <RadioGroupItem id={`${prefix}-${v}`} value={v} />
              {t}
            </label>
          ))}
        </RadioGroup>
      );
    case "fill_blank": {
      const count = q.blankCount || a.answers?.length || 1;
      return (
        <div className="space-y-3">
          {Array.from({ length: count }, (_, i) => (
            <label key={i} className="flex items-center gap-3">
              <span className="shrink-0 text-sm">{t("第 {0} 空", { 0: i + 1 })}</span>
              <Input
                aria-label={t("第 {0} 空", { 0: i + 1 })}
                disabled={disabled}
                value={a.answers?.[i] || ""}
                onChange={(e) => {
                  const answers = Array.from(
                    { length: count },
                    (_, j) => a.answers?.[j] || "",
                  );
                  answers[i] = e.target.value;
                  onChange({ answers });
                }}
              />
            </label>
          ))}
          {!q.blankCount && !disabled && (
            <Button
              variant="outline"
              onClick={() =>
                onChange({ answers: [...(a.answers || [""]), ""] })
              }
            >{t("增加一空")}</Button>
          )}
        </div>
      );
    }
    case "ordering": {
      const items = itemIds(q);
      const order = a.order || items.map((i) => i.id);
      const byId = new Map(items.map(item => [item.id, item]));
      function move(index: number, delta: number) {
        const next = [...order];
        [next[index], next[index + delta]] = [next[index + delta], next[index]];
        onChange({ order: next });
      }
      return (
        <div className="space-y-3">
          {order.map((id, index) => (
            <div
              key={id}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
              <span className="text-muted-foreground">{index + 1}</span>
              <div className="flex-1">
                <Markdown>{byId.get(id)?.content}</Markdown>
              </div>
              <Button
                size="icon"
                variant="ghost"
                disabled={disabled || index === 0}
                aria-label={t("第 {0} 项上移", { 0: index + 1 })}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={disabled || index === order.length - 1}
                aria-label={t("第 {0} 项下移", { 0: index + 1 })}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
            </div>
          ))}
          {!a.order && !disabled && (
            <Button variant="outline" onClick={() => onChange({ order })}>{t("确认当前顺序")}</Button>
          )}
        </div>
      );
    }
    case "matching":
      return (
        <div className="space-y-3">
          {itemIds(q, "left").map((item) => (
            <div
              key={item.id}
              className="grid grid-cols-2 items-center gap-4 rounded-lg border p-3"
            >
              <Markdown>{item.content}</Markdown>
              <Select
                disabled={disabled}
                value={
                  a.matches
                    ?.find((p) => p.left === item.id)
                    ?.right.toString() || ""
                }
                onValueChange={(v) =>
                  onChange({
                    matches: [
                      ...(a.matches || []).filter((p) => p.left !== item.id),
                      { left: item.id, right: Number(v) },
                    ],
                  })
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t("匹配 {0}", { 0: item.content })}
                >
                  <SelectValue placeholder={t("选择对应项")} />
                </SelectTrigger>
                <SelectContent>
                  {itemIds(q, "right").map((right, index) => (
                    <SelectItem key={right.id} value={String(right.id)}>
                      {q.questionKind === "paragraph_matching" ? right.label || String(index+1) : right.content}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      );
    default:
      return (
        <div className="space-y-2">
        <Textarea
          disabled={disabled}
          aria-label={t("作答内容")}
          placeholder={t("写下你的答案…")}
          value={a.text || ""}
          onChange={(e) => onChange({ text: e.target.value })}
          rows={q.questionKind === "writing" ? 14 : 7}
          spellCheck={false}
        />
        {q.questionKind === "writing" && <p role="status" className="text-sm text-muted-foreground">{t("当前 {0} 词",{0:countEnglishWords(a.text || "")})}
          {(q.minWords != null || q.maxWords != null) && <span> · {t("要求：{0}–{1} 词",{0:q.minWords ?? 0,1:q.maxWords ?? t("不限")})}</span>}
          {(q.minWords != null && countEnglishWords(a.text || "")<q.minWords || q.maxWords != null && countEnglishWords(a.text || "")>q.maxWords) && <span> · {t("词数超出要求范围，仍可提交。")}</span>}
        </p>}
        </div>
      );
  }
}
export function AnswerDisplay({
  answer,
  question,
}: {
  answer: Answer | null;
  question?: Question;
}) {
  useI18n();
  if (!answer)
    return (
      <p className="text-sm text-muted-foreground">{t("原文未提供标准答案，可保持未判定或自行评价。")}</p>
    );
  let rendered: string;
  if (answer.correct)
    rendered = answer.correct.map((s) => s ?? t("缺失")).join("、");
  else if (typeof answer.value === "boolean")
    rendered = answer.value ? t("正确") : t("错误");
  else if (answer.answers)
    rendered = answer.answers
      .map((s, i) => `${i + 1}. ${s ?? t("缺失")}`)
      .join("\n\n");
  else if (answer.order)
    rendered = answer.order
      .map((id) =>
        id == null
          ? t("缺失")
          : question
            ? itemIds(question).find((i) => i.id === id)?.content || t("题项缺失")
            : String(id),
      )
      .join(" → ");
  else if (answer.matches)
    rendered = answer.matches
      .map((p) => {
        if (!p) return t("缺失");
        const label = (side: "left" | "right") =>
          p[side] == null
            ? t("缺失")
            : question
              ? itemIds(question, side).find((i) => i.id === p[side])
                  ?.content || t("题项缺失")
              : String(p[side]);
        return `${label("left")} → ${label("right")}`;
      })
      .join("；");
  else rendered = answer.text || t("参考答案不完整");
  return <Markdown>{rendered}</Markdown>;
}
