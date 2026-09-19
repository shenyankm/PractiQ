import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { api, type Snapshot, type Visual } from "./api";
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
function ImageAsset({ visual }: { visual: Visual }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    if (visual.imageRef)
      void api<string | null>({ type: "asset", hash: visual.imageRef.sha256 })
        .then((s) => {
          if (active) setSrc(s);
        })
        .catch(() => {
          if (active) setSrc(null);
        });
    return () => {
      active = false;
    };
  }, [visual.imageRef?.sha256]);
  return (
    <figure className="space-y-2 rounded-lg border p-4">
      {src ? (
        <img
          src={src}
          alt={visual.description}
          className="max-h-96 max-w-full object-contain"
        />
      ) : visual.imageRef ? (
        <p className="text-sm text-muted-foreground">
          图片未导入，可依据下方文字作答或跳过。
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
}: {
  snapshot: Snapshot;
  source?: boolean;
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
        {q.stem || q.sourceText || "此题题干缺失，请查看以下内容或跳过。"}
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
        <ImageAsset key={v.id} visual={v} />
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
