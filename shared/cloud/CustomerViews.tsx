import { useEffect, useState } from "react";
import type { AccountUser, AccountUsage, DocumentTaskList } from "./contracts.generated";
import { accountRequest as request } from "./accountClient";
import { Field, Form, Records, errorMessage } from "./accountUI";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
export function AccountSettings({ user, onNameSaved }: { user: AccountUser; onNameSaved: (name: string) => void }) {
  const [password, setPassword] = useState(""),
    [email, setEmail] = useState(""),
    [name, setName] = useState(user.name),
    [newPassword, setNewPassword] = useState(""),
    [token, setToken] = useState(""),
    [tokenName, setTokenName] = useState("macOS App"),
    [revokeToken, setRevokeToken] = useState(""),
    [revokeSession, setRevokeSession] = useState(""),
    [revision, setRevision] = useState(0);
  return (
    <>
      <h1>账户与安全</h1>
      <p>邮箱暂不验证，仅作为登录标识。忘记密码请联系管理员。</p>
      <Form
        label="保存账户信息"
        submit={async () => {
          await request("/api/me/profile", "PATCH", {
            currentPassword: password,
            name,
            ...(email ? { email } : {}),
            ...(newPassword ? { password: newPassword } : {}),
          });
          setPassword("");
          if (email || newPassword)
            window.dispatchEvent(new Event("practiq-session-expired"));
          else onNameSaved(name);
        }}
      >
        <Field
          name="current-password"
          label="当前密码"
          type="password"
          value={password}
          onChange={setPassword}
        />
        <label className="account-field">
          昵称
          <Input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="account-field">
          新登录邮箱（可选）
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="account-field">
          新密码（可选，至少 12 字符）
          <Input
            type="password"
            minLength={12}
            maxLength={128}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
      </Form>
      <h2>App 评分连接</h2>
      <p>
        令牌仅允许连接检查和显式评分，有效期 90 天。复制到本应用设置中的 AI 服务连接设置，凭证由 Keychain 保存。
      </p>
      <Form
        label="创建个人评分令牌"
        submit={async () => {
          setToken("");
          const result = await request<{ token: string }>(
            "/api/me/tokens",
            "POST",
            { currentPassword: password, name: tokenName },
          );
          setToken(result.token);
          setPassword("");
          setRevision((v) => v + 1);
        }}
      >
        <Field
          name="token-password"
          label="当前密码"
          type="password"
          value={password}
          onChange={setPassword}
        />
        <Field
          name="token-name"
          label="连接名称"
          value={tokenName}
          onChange={setTokenName}
        />
      </Form>
      {token && (
        <div className="notice">
          <p>令牌仅展示本次，请立即复制。离开页面后无法再次查看。</p>
          <Input aria-label="新评分令牌" readOnly value={token} />
          <Button variant="outline" onClick={() => setToken("")}>
            隐藏令牌
          </Button>
        </div>
      )}
      <Records path="/api/me/tokens" refresh={revision} onSelect={row => setRevokeToken(String(row.id))} />
      <Form
        label="撤销指定令牌"
        submit={async () => {
          await request(
            `/api/me/tokens/${encodeURIComponent(revokeToken)}`,
            "DELETE",
          );
          setToken("");
          setRevokeToken("");
          setRevision((v) => v + 1);
        }}
      >
        <Field
          name="revoke-token"
          label="令牌编号"
          value={revokeToken}
          onChange={setRevokeToken}
        />
      </Form>
      <h2>登录会话</h2>
      <Records path="/api/me/sessions" refresh={revision} onSelect={row => setRevokeSession(String(row.id))} />
      <Form
        label="撤销指定会话"
        submit={async () => {
          await request(
            `/api/me/sessions/${encodeURIComponent(revokeSession)}`,
            "DELETE",
          );
          setRevokeSession("");
          setRevision((v) => v + 1);
        }}
      >
        <Field
          name="revoke-session"
          label="会话编号"
          value={revokeSession}
          onChange={setRevokeSession}
        />
      </Form>
    </>
  );
}
export function Usage() {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<AccountUsage | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<typeof data>(
      `/api/me/usage?offset=${offset}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [offset]);
  return (
    <>
      <h1>个人用量</h1>
      <p>
        新账户默认共有 50 页免费识别额度，累计使用，不按日恢复。未知结果仍保留预留页数；读取已保存结果不重复扣减。
      </p>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p role="status">免费识别额度：剩余 {data.remainingPages} / {data.limits.freePages} 页，已使用或预留 {data.usedPages} 页。</p>
          {data.remainingPages === 0 && <p className="notice">免费页数已用尽。请联系管理员调整额度；已保存的结果仍可查看和下载。</p>}
          <p>
            每日模型 {data.limits.modelCalls} 次 · 腾讯提交{" "}
            {data.limits.tencentCalls} 次 · 进行中任务 {data.limits.activeTasks}{" "}
            个
          </p>
          <p>每日调用次数按新加坡时间零点重置，免费页数不重置。任务暂停后需要手动继续。</p>
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>调用类型</th>
                <th>次数</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map((r) => (
                <tr key={r.day + r.kind}>
                  <td>{r.day}</td>
                  <td>{r.kind === "modelCalls" ? "模型调用" : "腾讯提交"}</td>
                  <td>{r.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>调用记录</h2>
          <div className="account-table"><table><thead><tr><th scope="col">日期</th><th scope="col">类型</th><th scope="col">用量状态</th><th scope="col">输入 / 输出 tokens</th></tr></thead><tbody>{data.calls.map(call => <tr key={call.call_key}><td>{call.day}</td><td>{call.kind === 'modelCalls' ? '模型调用' : '腾讯提交'}</td><td>{call.kind === 'tencentCalls' ? (call.record.taskId ? '已确认提交' : '提交结果未知') : call.record.usageStatus === 'known' ? '已知用量' : '未知用量'}</td><td>{call.kind === 'tencentCalls' ? '—' : `${typeof call.record.inputTokens === 'number' ? call.record.inputTokens : '未知'} / ${typeof call.record.outputTokens === 'number' ? call.record.outputTokens : '未知'}`}</td></tr>)}</tbody></table></div>
          <details>
            <summary>最近调用回执（包含未知结果）</summary>
            <pre>{JSON.stringify(data.calls, null, 2)}</pre>
          </details>
        </>
      )}
      <nav aria-label="调用记录分页"><Button variant="outline" disabled={!offset} onClick={() => setOffset(v => Math.max(0, v - 100))}>上一页</Button><Button variant="outline" disabled={!data || data.calls.length < 100} onClick={() => setOffset(v => v + 100)}>下一页</Button></nav>
    </>
  );
}
export function Banks({ open }: { open: (id: string) => void }) {
  const [data, setData] = useState<DocumentTaskList | null>(null),
    [offset, setOffset] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<DocumentTaskList>(
      `/api/me/banks?offset=${offset}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [offset]);
  return (
    <>
      <h1>我的题库</h1>
      <p>查看保存的解析结果、复核内容并下载题库 ZIP。下载不启动模型。</p>
      {error && <p role="alert">{error}</p>}
      {data?.items.length === 0 && <p>尚无已保存结果，请先导入文档。</p>}
      {data?.items.map((task) => (
        <section className="account-bank" key={task.threadId}>
          <div>
            <h2>{task.fileName}</h2>
            <p>
              {task.questionCount} 道题 · {task.reviewCount} 道待复核 · 有效至{" "}
              {task.expiresAt}
            </p>
          </div>
          <Button onClick={() => open(task.threadId)}>查看结果与下载</Button>
        </section>
      ))}
      <Button
        variant="outline"
        disabled={!offset}
        onClick={() => setOffset((v) => Math.max(0, v - 50))}
      >
        上一页
      </Button>
      <Button
        variant="outline"
        disabled={!data?.hasMore}
        onClick={() => setOffset((v) => v + 50)}
      >
        下一页
      </Button>
    </>
  );
}
