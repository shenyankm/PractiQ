import { useCallback, useEffect, useState } from 'react';
import { apiRequestPage } from '@/lib/api';

export function useApiResource<T>(url: string | null, initial: T) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!url) return;
    setLoading(true);
    setError('');
    try {
      const page = await apiRequestPage<T>(url, { signal });
      if (!signal?.aborted) {
        setData(page.data);
        setCursor(page.cursor);
        setHasMore(page.hasMore);
      }
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : '请求失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [url]);

  const loadMore = useCallback(async () => {
    if (!url || !cursor || !hasMore || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const separator = url.includes('?') ? '&' : '?';
      const page = await apiRequestPage<T>(`${url}${separator}cursor=${encodeURIComponent(cursor)}`);
      setData((current) => Array.isArray(current) && Array.isArray(page.data)
        ? [...current, ...page.data] as T
        : page.data);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '请求失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, hasMore, loadingMore, url]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void reload(controller.signal);
    });
    return () => controller.abort();
  }, [reload]);

  return { data, setData, loading, loadingMore, hasMore, error, reload, loadMore };
}
