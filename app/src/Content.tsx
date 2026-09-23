import { list, t, useI18n } from "./i18n";
import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { api, fieldName, type Snapshot, type Visual, type Block } from "./api";
import { ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
export const Markdown = memo(function Markdown({ children }: { children?: string | null }) {
  useI18n();
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
            <span className="text-muted-foreground">{t("[图片：{0}]", { 0: alt || t("请查看关联图片") })}</span>
          ),
          a: ({ children }) => <span className="underline">{children}</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  ) : null;
});
function Blocks({blocks}: {blocks: Block[]}) {
  return <>{blocks.map((b, i) => (
        <div key={i}>
          {b.partType === "blank" ? <span className="inline-block rounded border px-3 py-1">{t("空位")} {blocks.filter(v=>v.partType==="blank").findIndex(v=>v.questionId===b.questionId)+1}</span> : <>
            {b.latexValue && <Markdown>{`$$\n${b.latexValue}\n$$`}</Markdown>}
            <Markdown>{b.markdownValue}</Markdown>
            {b.textValue !== b.markdownValue && <Markdown>{b.textValue}</Markdown>}
          </>}
          {b.jsonValue && (
            <pre className="overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">
              {JSON.stringify(b.jsonValue, null, 2)}
            </pre>
          )}
        </div>
  ))}</>;
}
function ImageAsset({ visual, original = false }: { visual: Visual; original?: boolean }) {
  useI18n();
  const [src, setSrc] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const zoomButton = useRef<HTMLButtonElement>(null);
  const [loading, setLoading] = useState(!!visual.imageRef);
  const imageHash = visual.imageRef?.sha256;
  const mediaType = visual.imageRef?.mediaType;
  const loadExpanded = original && expanded;
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSrc(null);
    if (!original) setExpanded(false);
    setLoading(!!imageHash);
    if (imageHash && (!original || loadExpanded))
      void api({ type: "asset", hash: imageHash })
        .then((bytes) => {
          if (active) {
            objectUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
            setSrc(objectUrl);
          }
        })
        .catch(() => {
          if (active) setSrc(null);
        }).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageHash, mediaType, original, loadExpanded]);
  return (
    <figure className="space-y-2 rounded-lg border p-4">
      {src || original ? (
        <>
          {!original && src && <img src={src} alt={visual.description} className="max-h-[min(28vh,20rem)] max-w-full object-contain"/>}
          <Button ref={zoomButton} size="sm" variant="outline" onClick={() => setExpanded(true)}><ZoomIn/>{original ? t("查看原页") : t("放大查看图片")}</Button>
          <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); zoomButton.current?.focus(); }} className="flex max-h-[90vh] flex-col sm:max-w-[90vw]"><DialogHeader className="shrink-0 pr-8"><DialogTitle>{original ? t("查看原页") : t("查看图片")}</DialogTitle><DialogDescription>{visual.description || t("原始图片，可滚动查看完整细节。")}</DialogDescription></DialogHeader><div className="min-h-0 overflow-auto">{src ? <img src={src} alt={visual.description} className="max-w-none"/> : <p>{loading ? t("正在加载原页…") : t("原页不可用，请重新导入来源资源。")}</p>}</div></DialogContent></Dialog>
        </>
      ) : visual.imageRef ? (
        <p className="text-sm text-muted-foreground">
          {loading ? t("正在加载图片…") : t("图片不可用，可依据下方文字作答或跳过。")}
        </p>
      ) : null}
      <figcaption className="text-sm">
        <Markdown>{visual.label}</Markdown>
        <Markdown>{visual.description}</Markdown>
        <Markdown>{visual.extractedText}</Markdown>
        {!visual.questionIds.length && (
          <Badge variant="outline">{t("文档级素材，关联未确定")}</Badge>
        )}
      </figcaption>
    </figure>
  );
}
export const Content = memo(function Content({
  snapshot,
  source = false,
  exam = false,
  revealOriginal = true,
}: {
  snapshot: Snapshot;
  source?: boolean;
  exam?: boolean;
  revealOriginal?: boolean;
}) {
  useI18n();
  const q = snapshot.question;
  return (
    <div className="space-y-5">
      {(q.needsReview ||
        q.missingFields.length > 0 ||
        snapshot.missingAssets) && (
        <div role="note" className="rounded-lg border bg-muted/50 p-3 text-sm">
          <strong>{t("内容待复核，仍可练习。")}</strong>{" "}
          {snapshot.missingAssets ? t("部分图片未导入。") : ""}
          {q.missingFields.length > 0 &&
            t("缺失：{0}。", { 0: list(q.missingFields.map(fieldName)) })}
        </div>
      )}
      {snapshot.groups.map((g) => (
        <section key={g.id} className="rounded-lg border-l-4 bg-muted/40 p-4">
          <h3 className="mb-2 font-medium">{g.title}</h3>
          <Markdown>{g.instructions}</Markdown>
          <Blocks blocks={g.contentBlocks || []} />
        </section>
      ))}
      <Markdown>
        {q.stem || (!exam && q.sourceText) || t("此题题干缺失，请查看以下内容或跳过。")}
      </Markdown>
      <Blocks blocks={[...(q.passage || []), ...q.contentBlocks]} />
      {snapshot.visuals.map((v) => (
        <div key={v.id} className="space-y-2">
          <ImageAsset visual={{...v, extractedText: q.contentBlocks.some(b => b.markdownValue === v.extractedText) ? null : v.extractedText}} />
          {!exam && revealOriginal && v.sourceRef && <ImageAsset original visual={{...v, imageRef: v.sourceRef, label: null, extractedText: null, description: t("完整来源页，可能含参考答案。可对照检查表头、图例和裁剪边缘。")}} />}
        </div>
      ))}
      {source && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("原文与导入提示")}</summary>
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
});
