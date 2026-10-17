import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { t, useI18n } from "./i18n";
import { Button } from "@/components/ui/button";

export function RenderFailure({ onClose }: { onClose?: () => void }) {
  useI18n();
  return <section role="alert" className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
    <h2 className="text-lg font-semibold">{t("此界面暂时无法显示")}</h2>
    <p>{t("已保存的数据不受影响。重新加载可能丢失未保存的输入。")}</p>
    <div className="flex flex-wrap gap-3">
      {onClose && <Button variant="outline" onClick={onClose}>{t("关闭")}</Button>}
      <Button variant="outline" onClick={() => window.location.reload()}>{t("重新加载")}</Button>
    </div>
  </section>;
}

export function RenderFailureDialog({ onClose }: { onClose: () => void }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent aria-describedby={undefined}><DialogTitle className="sr-only">{t("此界面暂时无法显示")}</DialogTitle><RenderFailure onClose={onClose} /></DialogContent></Dialog>;
}
