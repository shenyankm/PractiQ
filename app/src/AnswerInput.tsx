import { list, t, useI18n } from "./i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ArrowUp, ArrowDown } from "lucide-react";
import { type Question, type Answer, canInteract, itemIds } from "./api";
import { answerLanguage, countEnglishWords, materialLanguage } from "./english";
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
  const lang = answerLanguage(q);
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
          lang={lang}
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
                <Markdown lang={materialLanguage(q)}>{o.content}</Markdown>
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
                <Markdown lang={materialLanguage(q)}>{o.content}</Markdown>
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
                lang={lang}
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
              <div className="min-w-0 flex-1">
                <Markdown lang={materialLanguage(q)}>{byId.get(id)?.content}</Markdown>
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
              className="grid grid-cols-1 items-center gap-4 sm:grid-cols-2 rounded-lg border p-3"
            >
              <Markdown lang={materialLanguage(q)}>{item.content}</Markdown>
              <NativeSelect
                className="w-full"
                aria-label={t("匹配 {0}", { 0: item.content })}
                disabled={disabled}
                value={
                  a.matches
                    ?.find((p) => p.left === item.id)
                    ?.right.toString() || ""
                }
                onChange={(event) =>
                  onChange({
                    matches: [
                      ...(a.matches || []).filter((p) => p.left !== item.id),
                      { left: item.id, right: Number(event.target.value) },
                    ],
                  })
                }
              >
                <NativeSelectOption value="" disabled>{t("选择对应项")}</NativeSelectOption>
                {itemIds(q, "right").map((right, index) => (
                  <NativeSelectOption lang={materialLanguage(q)} key={right.id} value={String(right.id)}>
                    {q.questionKind === "paragraph_matching" ? right.label || String(index+1) : right.content}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ))}
        </div>
      );
    default:
      return (
        <div className="space-y-2">
        <Textarea
          lang={lang}
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
  response,
}: {
  answer: Answer | null;
  question?: Question;
  response?: Answer | null;
}) {
  useI18n();
  const lang = answerLanguage(question);
  if (!answer)
    return (
      <p className="text-sm text-muted-foreground">{t("原文未提供标准答案，可保持未判定或自行评价。")}</p>
    );
  if (question?.answerMode === "fill_blank" && answer.answers && response?.answers) {
    return <div className="overflow-x-auto"><table className="w-full text-sm" aria-label={t("填空答案对照")}>
      <thead><tr className="border-b text-left"><th className="p-2">{t("空格")}</th><th className="p-2">{t("你的答案")}</th><th className="p-2">{t("参考答案")}</th><th className="p-2">{t("核对结果")}</th></tr></thead>
      <tbody>{Array.from({length:Math.max(answer.answers.length,response.answers.length)},(_,i)=>{
        const expected=answer.answers![i], actual=response.answers![i];
        const state=!expected?.trim()?t("参考答案不完整"):!actual?.trim()?t("未作答"):actual.trim()===expected.trim()?t("文本一致"):t("文本不一致");
        return <tr key={i} className="border-b align-top"><th scope="row" className="p-2 font-normal">{i+1}</th><td className="p-2"><Markdown lang={actual ? lang : undefined}>{actual || t("未作答")}</Markdown></td><td className="p-2"><Markdown lang={expected ? lang : undefined}>{expected || t("缺失")}</Markdown></td><td className="p-2">{state}</td></tr>;
      })}</tbody>
    </table></div>;
  }
  let rendered: string;
  let renderedLanguage: string | undefined;
  if (answer.correct)
    rendered = list(answer.correct.map((s) => s ?? t("缺失")));
  else if (typeof answer.value === "boolean")
    rendered = answer.value ? t("正确") : t("错误");
  else if (answer.answers) {
    renderedLanguage = answer.answers.every(value => value != null) ? lang : undefined;
    rendered = answer.answers
      .map((s, i) => `${i + 1}. ${s ?? t("缺失")}`)
      .join("\n\n");
  } else if (answer.order) {
    renderedLanguage = question && answer.order.every(id => id != null && itemIds(question).some(item => item.id === id && item.content)) ? lang : undefined;
    rendered = answer.order
      .map((id) =>
        id == null
          ? t("缺失")
          : question
            ? itemIds(question).find((i) => i.id === id)?.content || t("题项缺失")
            : String(id),
      )
      .join(" → ");
  } else if (answer.matches)
    return <div className="space-y-2">{answer.matches.map((p, index) => {
        if (!p) return <Markdown key={index}>{t("缺失")}</Markdown>;
        const label = (side: "left" | "right") =>
          p[side] == null
            ? t("缺失")
            : question
              ? itemIds(question, side).find((i) => i.id === p[side])
                  ?.content || t("题项缺失")
              : String(p[side]);
        const complete = question && (["left","right"] as const).every(side => p[side] != null && itemIds(question,side).some(item => item.id === p[side] && item.content));
        return <Markdown key={index} lang={complete ? lang : undefined}>{`${label("left")} → ${label("right")}`}</Markdown>;
      })}</div>;
  else { rendered = answer.text || t("参考答案不完整"); renderedLanguage = answer.text ? lang : undefined; }
  return <Markdown lang={renderedLanguage}>{rendered}</Markdown>;
}
