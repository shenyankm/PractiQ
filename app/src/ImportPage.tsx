import { AiTasks } from "./AiTasks";
import type { Preview } from "./api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ImportPage({ busy, run, onPickJson, onPreview }: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onPickJson: () => Promise<void>;
  onPreview: (preview: Preview) => void;
}) {
  return <div className="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle>导入已有题库</CardTitle>
        <CardDescription>支持 PractiQ 格式的 .json 文件，直接导入，无需 AI 解析或模型配置。</CardDescription>
      </CardHeader>
      <CardContent><Button disabled={busy} onClick={() => run(onPickJson)}>选择题库 JSON</Button></CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>从文档创建题库</CardTitle>
        <CardDescription>支持 PDF（.pdf）、文本（.txt）、表格文本（.csv），以及图片（.png、.jpg、.jpeg）。单个文件最大 25 MiB。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="rounded-lg bg-muted p-4 text-sm leading-relaxed">暂不支持 Word 文件（.doc、.docx）。Word 的排版可能随字体和软件变化，影响题目、公式和图片的位置。PDF 能固定页面布局，更适合识别。请先在 Word 或 WPS 中选择“导出为 PDF”或“另存为 PDF”，再上传。</p>
        <AiTasks busy={busy} run={run} onPreview={onPreview} />
      </CardContent>
    </Card>
  </div>;
}
