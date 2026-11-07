import { useCallback, useEffect, useRef, useState } from "react";
import { accountRequest, setAccount } from "./accountClient";
import { errorMessage } from "./accountUI";
import type { AccountSession } from "./contracts.generated";

export function useAccount() {
  const [account, updateAccount] = useState<AccountSession | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const live = useRef(false), latest = useRef<AccountSession | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; latest.current = null; }; }, []);
  const reload = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setAccount(null); updateAccount(null); latest.current = null;
    void accountRequest<AccountSession>("/api/auth/session", "GET", undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) { latest.current = value; setAccount(value); updateAccount(value); } })
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); setAccount(null); };
  }, [revision]);
  useEffect(() => {
    const expired = () => { setError("登录已失效，请重新登录。"); reload(); };
    window.addEventListener("practiq-session-expired", expired);
    const channel = new BroadcastChannel("practiq-account"); channel.onmessage = reload;
    return () => { channel.close(); window.removeEventListener("practiq-session-expired", expired); };
  }, [reload]);
  function signedIn(value: AccountSession) {
    if (!live.current) return;
    latest.current = value;
    setAccount(value); updateAccount(value); setError("");
    const channel = new BroadcastChannel("practiq-account"); channel.postMessage("changed"); channel.close();
  }
  function updateName(id: string, name: string) {
    const value = latest.current;
    if (value?.user?.id === id) signedIn({ ...value, user: { ...value.user, name } });
  }
  async function logout() {
    setError("");
    try { await accountRequest("/api/auth/logout", "POST"); }
    catch (e) { if (live.current) setError(errorMessage(e)); }
    finally { if (live.current) { latest.current = null; setAccount(null); updateAccount(null); reload(); const channel = new BroadcastChannel("practiq-account"); channel.postMessage("changed"); channel.close(); } }
  }
  return { account, user: account?.user ?? null, loading, error, setError, signedIn, logout, reload, updateName };
}
