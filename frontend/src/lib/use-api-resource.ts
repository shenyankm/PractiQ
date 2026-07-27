import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';

export function useApiResource<T>(url: string | null, initial: T) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState('');

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!url) return;
    setLoading(true);
    setError('');
    try {
      const value = await apiRequest<T>(url, { signal });
      if (!signal?.aborted) setData(value);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : '请求失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void reload(controller.signal);
    });
    return () => controller.abort();
  }, [reload]);

  return { data, setData, loading, error, reload };
}
