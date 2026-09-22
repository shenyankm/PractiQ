import { t, useI18n } from "./i18n";
import { useState } from "react";
import { blankQuestion, type Question, type Mode, modeNames, isComposite } from "./api";
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
export { blankQuestion } from "./api";
export function QuestionEditor({
  initial,
  initialChildren = [],
  parent,
  onClose,
  onSave,
  busy,
}: {
  initial: Question;
  initialChildren?: Question[];
  parent?: Question;
  onClose: () => void;
  onSave: (q: Question, children: Question[]) => void;
  busy: boolean;
}) {
  useI18n();
  const [q, setQ] = useState<Question>(() => structuredClone({...initial, id: initial.id || crypto.randomUUID()}));
  const [children, setChildren] = useState<Question[]>(() => structuredClone(initialChildren));
  const [childEditor, setChildEditor] = useState<Question | null>(null);
  const patch = (p: Partial<Question>) => setQ((v) => ({ ...v, ...p }));
  function mode(value: Mode) {
    setChildren([]);
    patch({
      passage: [], optionSourceId: null, allowReuse:false, blankCount:value === "fill_blank" ? 1 : null,
      answerMode: value,
      questionTypeId: modeNames()[value],
      choiceVariant: value === "choice" ? "single" : null,
      matchingVariant: value === "matching" ? "one_to_one" : null,
      options:
        (value === "choice" || value === "word_bank")
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
          <DialogTitle>{t("编辑题目")}</DialogTitle>
        </DialogHeader>
        <fieldset disabled={busy} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="answer-mode">{t("答题方式")}</Label>
              <Select
                disabled={parent?.answerMode === "word_bank" || parent?.answerMode === "cloze"}
                value={q.answerMode || ""}
                onValueChange={(v) => mode(v as Mode)}
              >
                <SelectTrigger id="answer-mode" className="w-full">
                  <SelectValue placeholder={t("选择答题方式")} />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(modeNames()).filter(([k]) => !parent || (parent.answerMode === "reading" ? k !== "reading" : k === "choice")).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="typeName">{t("题型名称")}</Label>
              <Input
                id="typeName"
                value={q.questionTypeId || ""}
                onChange={(e) => patch({ questionTypeId: e.target.value })}
              />
            </div>
          </div>
          {q.answerMode === "choice" && (
            <Select
              disabled={parent?.answerMode === "word_bank" || parent?.answerMode === "cloze"}
              value={q.choiceVariant || "single"}
              onValueChange={(v) =>
                patch({
                  choiceVariant: v as "single" | "multiple",
                  answerPayload: null,
                })
              }
            >
              <SelectTrigger aria-label={t("选择题类型")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">{t("单选")}</SelectItem>
                <SelectItem value="multiple">{t("多选")}</SelectItem>
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
              <SelectTrigger aria-label={t("匹配类型")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one_to_one">{t("一对一匹配")}</SelectItem>
                <SelectItem value="many_to_one">{t("多对一匹配")}</SelectItem>
              </SelectContent>
            </Select>
          )}
          <div className="space-y-2">
            <Label htmlFor="stem">{t("题干（支持 Markdown 和公式）")}</Label>
            <Textarea
              id="stem"
              rows={5}
              value={q.stem || ""}
              onChange={(e) => patch({ stem: e.target.value })}
            />
          </div>
          {(q.answerMode === "choice" && !q.optionSourceId || q.answerMode === "word_bank") && (
            <div className="space-y-3">
              <Label>{t("选项")}</Label>
              {q.options.map((o, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    className="w-20"
                    aria-label={t("选项 {0} 标签", { 0: i + 1 })}
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
                    aria-label={t("选项 {0} 内容", { 0: i + 1 })}
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
                  >{t("删除")}</Button>
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
              >{t("增加选项")}</Button>
            </div>
          )}
          {(q.answerMode === "ordering" || q.answerMode === "matching") && (
            <div className="space-y-3">
              <Label>{t("题项")}</Label>
              {q.items.map((item, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-12 text-sm">{i + 1}</span>
                  {q.answerMode === "matching" && (
                    <span className="w-16 text-sm">
                      {item.side === "left" ? t("左侧") : t("右侧")}
                    </span>
                  )}
                  <Input
                    aria-label={t("题项 {0}", { 0: i + 1 })}
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
                  >{t("删除")}</Button>
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
                    >{t("增加{0}题项", { 0: side === "left"
                        ? t("左侧")
                        : side === "right"
                          ? t("右侧")
                          : "" })}</Button>
                  ),
                )}
              </div>
            </div>
          )}
          {q.answerMode === "fill_blank" && <label className="grid gap-2">{t("空位数量")}<Input type="number" min={1} max={100} value={q.blankCount ?? ""} onChange={e => patch({blankCount:e.target.value ? Number(e.target.value) : null, answerPayload:null})}/></label>}
          {isComposite(q) && <section className="space-y-3 rounded-lg border p-4">
            <Label>{t("共享文章与空位")}</Label>
            {(q.passage || []).map((b,i) => <div key={i} className="flex gap-2">
              {b.partType === "blank" ? <span>{t("空位")} {children.findIndex(c => c.id === b.questionId)+1}</span> : <Textarea aria-label={t("文章段落")} value={b.markdownValue || b.textValue || b.latexValue || ""} onChange={e => patch({passage:q.passage!.map((v,j)=>j===i ? {...v,textValue:e.target.value,markdownValue:null,latexValue:null}:v)})}/>}
              {b.partType !== "blank" && <Button variant="outline" onClick={()=>patch({passage:q.passage!.filter((_,j)=>j!==i)})}>{t("删除")}</Button>}
            </div>)}
            <Button variant="outline" onClick={()=>patch({passage:[...(q.passage || []),{partType:"text",textValue:""}]})}>{t("增加文章段落")}</Button>
            {q.answerMode === "word_bank" && <label className="flex items-center gap-2"><input type="checkbox" checked={q.allowReuse || false} onChange={e=>patch({allowReuse:e.target.checked})}/>{t("允许重复选词")}</label>}
            {children.filter(c=>c.parentId===q.id).map((c,i)=><div key={c.id} className="flex items-center gap-2"><span className="flex-1">{i+1}. {c.stem || t("题干缺失")}</span><Button variant="outline" onClick={()=>setChildEditor(c)}>{t("编辑题目")}</Button><Button variant="outline" onClick={()=>{ const removed=new Set([c.id]); for(const v of children) if(removed.has(v.parentId)) removed.add(v.id); setChildren(children.filter(v=>!removed.has(v.id)));patch({passage:(q.passage || []).filter(b=>!removed.has(b.questionId))}); }}>{t("删除")}</Button></div>)}
            <Button variant="outline" onClick={()=>{const c=blankQuestion();c.parentId=q.id;c.stem=q.answerMode === "reading" ? "" : t("空位");if(q.answerMode === "word_bank"){c.optionSourceId=q.id;c.options=[];}setChildEditor(c);}}>{t("增加子题")}</Button>
          </section>}
          {!isComposite(q) && <div className="space-y-3 rounded-lg border p-4">

            <div className="flex justify-between">
              <Label>{t("参考答案（可留空）")}</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => patch({ answerPayload: null })}
              >{t("清空参考答案")}</Button>
            </div>
            <AnswerInput
              prefix="editor-answer"
              question={{ ...q, options: q.optionSourceId ? parent?.options || [] : q.options, answerPayload: null }}
              value={q.answerPayload}
              onChange={(a) => patch({ answerPayload: a })}
            />
          </div>}
          <div className="space-y-2">
            <Label htmlFor="sourceScore">{t("原卷分值（没有则留空）")}</Label>
            <Input id="sourceScore" type="number" min="0.01" max="1000000" step="0.01" value={q.sourceScore ?? ""} onChange={e => patch({sourceScore: e.target.value === "" ? null : Number(e.target.value)})}/>
            <Label htmlFor="scoringRubric">{t("原文评分细则")}</Label>
            <Textarea id="scoringRubric" value={q.scoringRubric || ""} onChange={e => patch({scoringRubric:e.target.value || null})}/>
            <Label htmlFor="scoreSourceText">{t("分值与细则的原文依据")}</Label>
            <Textarea id="scoreSourceText" value={q.scoreSourceText || ""} onChange={e => patch({scoreSourceText:e.target.value || null})}/>
          </div>
          <div className="space-y-2">
            <Label htmlFor="analysis">{t("解析")}</Label>
            <Textarea
              id="analysis"
              rows={4}
              value={q.analysis || ""}
              onChange={(e) => patch({ analysis: e.target.value || null })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sourceText">{t("来源原文")}</Label>
            <Textarea
              id="sourceText"
              rows={3}
              value={q.sourceText || ""}
              onChange={(e) => patch({ sourceText: e.target.value || null })}
            />
          </div>
        </fieldset>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("取消")}</Button>
          <Button disabled={busy} onClick={() => onSave(q,children)}>{t("保存题目")}</Button>
        </DialogFooter>
      </DialogContent>
      {childEditor && <QuestionEditor key={childEditor.id} initial={childEditor} parent={q} initialChildren={children.filter(c=>c.parentId===childEditor.id)} busy={false} onClose={()=>setChildEditor(null)} onSave={(child,nested)=>{
        const removed=new Set([child.id]);for(const c of children) if(removed.has(c.parentId))removed.add(c.id);
        const index=children.findIndex(c=>c.id===child.id);const kept=children.filter(c=>!removed.has(c.id));kept.splice(index<0 ? kept.length : index,0,child,...nested);setChildren(kept);
        if(q.answerMode !== "reading" && !(q.passage || []).some(b=>b.questionId===child.id))patch({passage:[...(q.passage || []),{partType:"blank",questionId:child.id}]});
        setChildEditor(null);
      }}/>}
    </Dialog>
  );
}
