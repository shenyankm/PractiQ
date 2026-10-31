import { useEffect, useState } from "react";

export function useSearchReady(search: string, scope: string) {
  const [settled, setSettled] = useState({ search, scope });
  useEffect(() => {
    if (settled.search === search && settled.scope === scope) return;
    if (settled.scope !== scope) {
      setSettled({ search, scope });
      return;
    }
    const timer = setTimeout(() => setSettled({ search, scope }), 150);
    return () => clearTimeout(timer);
  }, [search, scope, settled]);
  return settled.scope !== scope || settled.search === search;
}
