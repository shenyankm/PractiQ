import { Button } from "./components/ui/button";
export function RenderFailure() {
  return <section role="alert" className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
    <h2 className="text-lg font-semibold">此界面暂时无法显示</h2>
    <p>已创建的任务仍可查询。重新加载会清除本页未提交的输入和账户连接，请重新连接后查询原任务或订单。</p>
    <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => window.location.reload()}>重新加载页面</Button></div>
  </section>;
}
