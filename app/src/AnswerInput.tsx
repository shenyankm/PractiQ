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
import { Markdown } from "./Content";
export function AnswerInput({
  question: q,
  value,
  onChange,
  disabled = false,
  prefix = "answer",
}: {
  question: Question;
  value: Answer | null;
  onChange: (a: Answer) => void;
  disabled?: boolean;
  prefix?: string;
}) {
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
        <p className="text-sm text-muted-foreground">
          题目结构不完整，使用自由作答并自评。
        </p>
        <Textarea
          aria-label="自由作答"
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
          <legend className="mb-2 text-sm text-muted-foreground">
            多选题，可选择多个答案
          </legend>
          {q.options.map((o, i) => (
            <label
              key={i}
              htmlFor={`${prefix}-${i}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-4"
            >
              <Checkbox
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
              <div className="flex-1">
                <span className="font-medium">{o.label}.</span>{" "}
                <Markdown>{o.content}</Markdown>
              </div>
            </label>
          ))}
        </fieldset>
      ) : (
        <RadioGroup
          disabled={disabled}
          value={a.correctOption || ""}
          onValueChange={(v) => onChange({ correctOption: v })}
          aria-label="选择答案"
        >
          {q.options.map((o, i) => (
            <label
              key={i}
              htmlFor={`${prefix}-${i}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-4"
            >
              <RadioGroupItem id={`${prefix}-${i}`} value={o.label!} />
              <div className="flex-1">
                <span className="font-medium">{o.label}.</span>
                <Markdown>{o.content}</Markdown>
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
          aria-label="判断答案"
        >
          {[
            ["true", "正确"],
            ["false", "错误"],
          ].map(([v, t]) => (
            <label
              key={v}
              className="flex items-center gap-3 rounded-lg border p-4"
            >
              <RadioGroupItem value={v} />
              {t}
            </label>
          ))}
        </RadioGroup>
      );
    case "fill_blank": {
      const count = q.answerPayload?.answers?.length || a.answers?.length || 1;
      return (
        <div className="space-y-3">
          {Array.from({ length: count }, (_, i) => (
            <label key={i} className="flex items-center gap-3">
              <span className="shrink-0 text-sm">第 {i + 1} 空</span>
              <Input
                aria-label={`第 ${i + 1} 空`}
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
          {!q.answerPayload?.answers?.length && !disabled && (
            <Button
              variant="outline"
              onClick={() =>
                onChange({ answers: [...(a.answers || [""]), ""] })
              }
            >
              增加一空
            </Button>
          )}
        </div>
      );
    }
    case "ordering": {
      const items = itemIds(q);
      const order = a.order || items.map((i) => i.id);
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
                <Markdown>{items.find((i) => i.id === id)?.content}</Markdown>
              </div>
              <Button
                size="icon"
                variant="ghost"
                disabled={disabled || index === 0}
                aria-label={`第 ${index + 1} 项上移`}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={disabled || index === order.length - 1}
                aria-label={`第 ${index + 1} 项下移`}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
            </div>
          ))}
          {!a.order && !disabled && (
            <Button variant="outline" onClick={() => onChange({ order })}>
              确认当前顺序
            </Button>
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
                  aria-label={`匹配 ${item.content}`}
                >
                  <SelectValue placeholder="选择对应项" />
                </SelectTrigger>
                <SelectContent>
                  {itemIds(q, "right").map((right) => (
                    <SelectItem key={right.id} value={String(right.id)}>
                      {right.content}
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
        <Textarea
          disabled={disabled}
          aria-label="作答内容"
          placeholder="写下你的答案…"
          value={a.text || ""}
          onChange={(e) => onChange({ text: e.target.value })}
          rows={7}
        />
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
  if (!answer)
    return (
      <p className="text-sm text-muted-foreground">
        原文未提供标准答案，可保持未判定或自行评价。
      </p>
    );
  let rendered: string;
  if (typeof answer.correctOption === "string") rendered = answer.correctOption;
  else if (answer.correct)
    rendered = answer.correct.map((s) => s ?? "缺失").join("、");
  else if (typeof answer.value === "boolean")
    rendered = answer.value ? "正确" : "错误";
  else if (answer.answers)
    rendered = answer.answers
      .map((s, i) => `${i + 1}. ${s ?? "缺失"}`)
      .join("\n\n");
  else if (answer.order)
    rendered = answer.order
      .map((id) =>
        id == null
          ? "缺失"
          : question
            ? itemIds(question).find((i) => i.id === id)?.content || "题项缺失"
            : String(id),
      )
      .join(" → ");
  else if (answer.matches)
    rendered = answer.matches
      .map((p) => {
        if (!p) return "缺失";
        const label = (side: "left" | "right") =>
          p[side] == null
            ? "缺失"
            : question
              ? itemIds(question, side).find((i) => i.id === p[side])
                  ?.content || "题项缺失"
              : String(p[side]);
        return `${label("left")} → ${label("right")}`;
      })
      .join("；");
  else rendered = answer.text || "参考答案不完整";
  return <Markdown>{rendered}</Markdown>;
}
