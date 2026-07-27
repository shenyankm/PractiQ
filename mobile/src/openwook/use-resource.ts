import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { apiRequest } from './api';
import { readResource, writeResource } from './cache';

export function useCachedResource<T>(key: string, path: string, initial: T) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setRefreshing(true);
    setError('');
    const cached = await readResource<T>(key);
    if (cached !== null) {
      setData(cached);
      setLoading(false);
    }
    try {
      const fresh = await apiRequest<T>(path);
      setData(fresh);
      await writeResource(key, fresh);
    } catch (reason) {
      if (cached === null) setError(reason instanceof Error ? reason.message : '读取失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [key, path]);

  useFocusEffect(useCallback(() => {
    void reload();
  }, [reload]));

  const update = useCallback(async (value: T) => {
    setData(value);
    await writeResource(key, value);
  }, [key]);

  return { data, loading, refreshing, error, reload, update };
}
