import { useState } from "react";
import { type Question, type Mode, modeNames } from "./api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AnswerInput } from "./AnswerInput";
export function blankQuestion(): Question {
  return {
    stem: "",
    questionTypeId: "单选题",
    answerMode: "choice",
    choiceVariant: "single",
    matchingVariant: null,
    options: [
      { label: "A", content: "" },
      { label: "B", content: "" },
    ],
    items: [],
    answerPayload: null,
    analysis: null,
    sourceText: null,
    contentBlocks: [],
    needsReview: false,
    missingFields: [],
    confidence: 0,
  };
}
export function QuestionEditor({
  initial,
  onClose,
  onSave,
  busy,
}: {
  initial: Question;
  onClose: () => void;
  onSave: (q: Question) => void;
  busy: boolean;
}) {
  const [q, setQ] = useState<Question>(structuredClone(initial));
  const patch = (p: Partial<Question>) => setQ((v) => ({ ...v, ...p }));
  function mode(value: Mode) {
    patch({
      answerMode: value,
      questionTypeId: modeNames[value],
      choiceVariant: value === "choice" ? "single" : null,
      matchingVariant: value === "matching" ? "one_to_one" : null,
      options:
        value === "choice"
          ? [
              { label: "A", content: "" },
              { label: "B", content: "" },
            ]
          : [],
      items:
        value === "ordering"
          ? [
              { id: 0, content: "" },
              { id: 1, content: "" },
            ]
          : value === "matching"
            ? [
                { id: 0, side: "left", content: "" },
                { id: 1, side: "left", content: "" },
                { id: 0, side: "right", content: "" },
                { id: 1, side: "right", content: "" },
              ]
            : [],
      answerPayload: null,
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>编辑题目</DialogTitle>
        </DialogHeader>
        <fieldset disabled={busy} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="answer-mode">答题方式</Label>
              <Select
                value={q.answerMode || ""}
                onValueChange={(v) => mode(v as Mode)}
              >
                <SelectTrigger id="answer-mode" className="w-full">
                  <SelectValue placeholder="选择答题方式" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(modeNames).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="typeName">题型名称</Label>
              <Input
                id="typeName"
                value={q.questionTypeId || ""}
                onChange={(e) => patch({ questionTypeId: e.target.value })}
              />
            </div>
          </div>
          {q.answerMode === "choice" && (
            <Select
              value={q.choiceVariant || "single"}
              onValueChange={(v) =>
                patch({
                  choiceVariant: v as "single" | "multiple",
                  answerPayload: null,
                })
              }
            >
              <SelectTrigger aria-label="选择题类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">单选</SelectItem>
                <SelectItem value="multiple">多选</SelectItem>
              </SelectContent>
            </Select>
          )}
          {q.answerMode === "matching" && (
            <Select
              value={q.matchingVariant || "one_to_one"}
              onValueChange={(v) =>
                patch({
                  matchingVariant: v as "one_to_one" | "many_to_one",
                  answerPayload: null,
                })
              }
            >
              <SelectTrigger aria-label="匹配类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one_to_one">一对一匹配</SelectItem>
                <SelectItem value="many_to_one">多对一匹配</SelectItem>
              </SelectContent>
            </Select>
          )}
          <div className="space-y-2">
            <Label htmlFor="stem">题干（支持 Markdown 和公式）</Label>
            <Textarea
              id="stem"
              rows={5}
              value={q.stem || ""}
              onChange={(e) => patch({ stem: e.target.value })}
            />
          </div>
          {q.answerMode === "choice" && (
            <div className="space-y-3">
              <Label>选项</Label>
              {q.options.map((o, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    className="w-20"
                    aria-label={`选项 ${i + 1} 标签`}
                    value={o.label || ""}
                    onChange={(e) =>
                      patch({
                        options: q.options.map((o, j) =>
                          j === i ? { ...o, label: e.target.value } : o,
                        ),
                        answerPayload: null,
                      })
                    }
                  />
                  <Input
                    aria-label={`选项 ${i + 1} 内容`}
                    value={o.content || ""}
                    onChange={(e) =>
                      patch({
                        options: q.options.map((o, j) =>
                          j === i ? { ...o, content: e.target.value } : o,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="outline"
                    onClick={() =>
                      patch({
                        options: q.options.filter((_, j) => i !== j),
                        answerPayload: null,
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                disabled={q.options.length >= 100}
                onClick={() =>
                  patch({
                    options: [
                      ...q.options,
                      {
                        label: String.fromCharCode(65 + q.options.length),
                        content: "",
                      },
                    ],
                  })
                }
              >
                增加选项
              </Button>
            </div>
          )}
          {(q.answerMode === "ordering" || q.answerMode === "matching") && (
            <div className="space-y-3">
              <Label>题项</Label>
              {q.items.map((item, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-12 text-sm">{i + 1}</span>
                  {q.answerMode === "matching" && (
                    <span className="w-16 text-sm">
                      {item.side === "left" ? "左侧" : "右侧"}
                    </span>
                  )}
                  <Input
                    aria-label={`题项 ${i + 1}`}
                    value={item.content || ""}
                    onChange={(e) =>
                      patch({
                        items: q.items.map((v, j) =>
                          j === i ? { ...v, content: e.target.value } : v,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="outline"
                    onClick={() =>
                      patch({
                        items: q.items.filter((_, j) => i !== j),
                        answerPayload: null,
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                {(q.answerMode === "matching" ? ["left", "right"] : [null]).map(
                  (side) => (
                    <Button
                      key={side || "all"}
                      variant="outline"
                      disabled={q.items.length >= 100}
                      onClick={() => {
                        const ids = q.items
                          .filter((i) => !side || i.side === side)
                          .map((v, i) => v.id ?? i);
                        patch({
                          items: [
                            ...q.items,
                            {
                              id: Math.max(-1, ...ids) + 1,
                              side: side as "left" | "right" | null,
                              content: "",
                            },
                          ],
                          answerPayload: null,
                        });
                      }}
                    >
                      增加
                      {side === "left"
                        ? "左侧"
                        : side === "right"
                          ? "右侧"
                          : ""}
                      题项
                    </Button>
                  ),
                )}
              </div>
            </div>
          )}
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex justify-between">
              <Label>参考答案（可留空）</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => patch({ answerPayload: null })}
              >
                清空参考答案
              </Button>
            </div>
            <AnswerInput
              prefix="editor-answer"
              question={{ ...q, answerPayload: null }}
              value={q.answerPayload}
              onChange={(a) => patch({ answerPayload: a })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sourceScore">原卷分值（没有则留空）</Label>
            <Input id="sourceScore" type="number" min="0.01" max="1000000" step="0.01" value={q.sourceScore ?? ""} onChange={e => patch({sourceScore: e.target.value === "" ? null : Number(e.target.value)})}/>
            <Label htmlFor="scoringRubric">原文评分细则</Label>
            <Textarea id="scoringRubric" value={q.scoringRubric || ""} onChange={e => patch({scoringRubric:e.target.value || null})}/>
            <Label htmlFor="scoreSourceText">分值与细则的原文依据</Label>
            <Textarea id="scoreSourceText" value={q.scoreSourceText || ""} onChange={e => patch({scoreSourceText:e.target.value || null})}/>
          </div>
          <div className="space-y-2">
            <Label htmlFor="analysis">解析</Label>
            <Textarea
              id="analysis"
              rows={4}
              value={q.analysis || ""}
              onChange={(e) => patch({ analysis: e.target.value || null })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sourceText">来源原文</Label>
            <Textarea
              id="sourceText"
              rows={3}
              value={q.sourceText || ""}
              onChange={(e) => patch({ sourceText: e.target.value || null })}
            />
          </div>
        </fieldset>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => onSave(q)}>
            保存题目
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
