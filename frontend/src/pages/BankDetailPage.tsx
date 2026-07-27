import { useState } from 'react';
import { Alert, Button, Card, Link, Typography } from '@heroui/react';
import { useParams } from 'react-router-dom';
import { PageState } from '@/components/PageState';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import type { Bank, BankItem } from '@/lib/types';

export default function BankDetailPage() {
  const { bankId = '' } = useParams();
  const bank = useApiResource<Bank>(bankId ? `/api/v1/banks/${bankId}` : null, {} as Bank);
  const items = useApiResource<BankItem[]>(bankId ? `/api/v1/banks/${bankId}/items?limit=100` : null, []);
  const [error, setError] = useState('');

  async function favorite() {
    setError('');
    try {
      await apiRequest(`/api/v1/banks/${bankId}/favorite`, {
        method: bank.data.is_favorite ? 'DELETE' : 'POST'
      });
      bank.setData({ ...bank.data, is_favorite: !bank.data.is_favorite });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    }
  }

  async function remove() {
    if (!window.confirm('确定删除这个题库？')) return;
    try {
      await apiRequest(`/api/v1/banks/${bankId}`, { method: 'DELETE' });
      window.location.assign('/banks');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败');
    }
  }

  const loading = bank.loading || items.loading;
  const loadError = bank.error || items.error;
  return (
    <section className="grid gap-5">
      <Link href="/banks">返回题库</Link>
      <PageState loading={loading} error={loadError} retry={() => void Promise.all([bank.reload(), items.reload()])} />
      {error ? <Alert status="danger"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert> : null}
      {!loading && !loadError ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Typography.Heading level={1}>{bank.data.name}</Typography.Heading>
              <p>{bank.data.description || '暂无描述'}</p>
              <p className="text-sm text-muted">{bank.data.subject} · {items.data.length} 题</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onPress={() => void favorite()}>{bank.data.is_favorite ? '取消收藏' : '收藏'}</Button>
              <Link href={`/banks/${bankId}/practice`}>开始练习</Link>
              {bank.data.is_owner ? <Link href={`/banks/${bankId}/manage`}>管理题目</Link> : null}
              {bank.data.is_owner ? <Button onPress={() => void remove()} variant="danger">删除</Button> : null}
            </div>
          </div>
          <div className="grid gap-3">
            {items.data.map((item, index) => (
              <Card key={`${item.group_id || 0}-${item.question_id}`}>
                <Card.Content className="grid gap-2">
                  <p className="text-sm text-muted">第 {index + 1} 题 · {item.question_status}</p>
                  <p>{item.stem}</p>
                  <Link href={`/questions/${item.question_id}`}>查看题目</Link>
                </Card.Content>
              </Card>
            ))}
            {!items.data.length ? <p>题库中还没有题目。</p> : null}
            {items.hasMore ? <Button isDisabled={items.loadingMore} onPress={() => void items.loadMore()}>{items.loadingMore ? '加载中…' : '加载更多题目'}</Button> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
