import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { api, type Snapshot, type Visual } from "./api";
import { ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
export function Markdown({ children }: { children?: string | null }) {
  return children ? (
    <div className="document-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [
            rehypeKatex,
            {
              trust: false,
              strict: "ignore",
              throwOnError: false,
              maxExpand: 1000,
            },
          ],
        ]}
        skipHtml
        components={{
          img: ({ alt }) => (
            <span className="text-muted-foreground">
              [图片：{alt || "请查看关联图片"}]
            </span>
          ),
          a: ({ children }) => <span className="underline">{children}</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  ) : null;
}
function ImageAsset({ visual, original = false }: { visual: Visual; original?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const zoomButton = useRef<HTMLButtonElement>(null);
  const [loading, setLoading] = useState(!!visual.imageRef);
  useEffect(() => {
    let active = true;
    setSrc(null);
    if (!original) setExpanded(false);
    setLoading(!!visual.imageRef);
    if (visual.imageRef && (!original || expanded))
      void api<string | null>({ type: "asset", hash: visual.imageRef.sha256 })
        .then((s) => {
          if (active) setSrc(s);
        })
        .catch(() => {
          if (active) setSrc(null);
        }).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
    };
  }, [visual.imageRef?.sha256, original, original && expanded]);
  return (
    <figure className="space-y-2 rounded-lg border p-4">
      {src || original ? (
        <>
          {!original && src && <img src={src} alt={visual.description} className="max-h-[min(28vh,20rem)] max-w-full object-contain"/>}
          <Button ref={zoomButton} size="sm" variant="outline" onClick={() => setExpanded(true)}><ZoomIn/>{original ? "查看原页" : "放大查看图片"}</Button>
          <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); zoomButton.current?.focus(); }} className="flex max-h-[90vh] flex-col sm:max-w-[90vw]"><DialogHeader className="shrink-0 pr-8"><DialogTitle>{original ? "查看原页" : "查看图片"}</DialogTitle><DialogDescription>{visual.description || "原始图片，可滚动查看完整细节。"}</DialogDescription></DialogHeader><div className="min-h-0 overflow-auto">{src ? <img src={src} alt={visual.description} className="max-w-none"/> : <p>{loading ? "正在加载原页…" : "原页不可用，请重新导入来源资源。"}</p>}</div></DialogContent></Dialog>
        </>
      ) : visual.imageRef ? (
        <p className="text-sm text-muted-foreground">
          {loading ? "正在加载图片…" : "图片不可用，可依据下方文字作答或跳过。"}
        </p>
      ) : null}
      <figcaption className="text-sm">
        <Markdown>{visual.label}</Markdown>
        <Markdown>{visual.description}</Markdown>
        <Markdown>{visual.extractedText}</Markdown>
        {!visual.questionIds.length && (
          <Badge variant="outline">文档级素材，关联未确定</Badge>
        )}
      </figcaption>
    </figure>
  );
}
export function Content({
  snapshot,
  source = false,
  exam = false,
}: {
  snapshot: Snapshot;
  source?: boolean;
  exam?: boolean;
}) {
  const q = snapshot.question;
  return (
    <div className="space-y-5">
      {(q.needsReview ||
        q.missingFields.length > 0 ||
        snapshot.missingAssets) && (
        <div role="note" className="rounded-lg border bg-muted/50 p-3 text-sm">
          <strong>内容待复核，仍可练习。</strong>{" "}
          {snapshot.missingAssets ? "部分图片未导入。" : ""}
          {q.missingFields.length > 0 &&
            `缺失：${q.missingFields.map((k) => ({ stem: "题干", questionTypeId: "题型", answerMode: "答题方式", choiceVariant: "单/多选类型", matchingVariant: "匹配类型", options: "选项", items: "题项", answerPayload: "参考答案", analysis: "解析", sourceText: "原文", media: "图片", material: "材料" })[k] || k).join("、")}。`}
        </div>
      )}
      {snapshot.groups.map((g) => (
        <section key={g.id} className="rounded-lg border-l-4 bg-muted/40 p-4">
          <h3 className="mb-2 font-medium">{g.title}</h3>
          <Markdown>{g.instructions}</Markdown>
        </section>
      ))}
      <Markdown>
        {q.stem || (!exam && q.sourceText) || "此题题干缺失，请查看以下内容或跳过。"}
      </Markdown>
      {q.contentBlocks.map((b, i) => (
        <div key={i}>
          {b.latexValue ? (
            <Markdown>{`$$\n${b.latexValue}\n$$`}</Markdown>
          ) : (
            <Markdown>{b.markdownValue || b.textValue}</Markdown>
          )}
          {b.jsonValue && (
            <pre className="overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">
              {JSON.stringify(b.jsonValue, null, 2)}
            </pre>
          )}
        </div>
      ))}
      {snapshot.visuals.map((v) => (
        <div key={v.id} className="space-y-2">
          <ImageAsset visual={{...v, extractedText: q.contentBlocks.some(b => b.markdownValue === v.extractedText) ? null : v.extractedText}} />
          {!exam && v.sourceRef && <ImageAsset original visual={{...v, imageRef: v.sourceRef, label: null, extractedText: null, description: "完整来源页，可能含参考答案。可对照检查表头、图例和裁剪边缘。"}} />}
        </div>
      ))}
      {source && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            原文与导入提示
          </summary>
          <div className="mt-3 space-y-2">
            <Markdown>{q.sourceText}</Markdown>
            {snapshot.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
            {snapshot.sources.map((s, i) => (
              <pre key={i} className="whitespace-pre-wrap">
                {JSON.stringify(s, null, 2)}
              </pre>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
