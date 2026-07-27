import { useMemo, useState } from 'react';
import { Button, Card, Input, Link, Typography } from '@heroui/react';
import { PageState } from '@/components/PageState';
import { useApiResource } from '@/lib/use-api-resource';
import type { Bank } from '@/lib/types';

export default function BanksPage() {
  const [scope, setScope] = useState('mine');
  const [query, setQuery] = useState('');
  const url = useMemo(() => `/api/v1/banks?scope=${scope}&q=${encodeURIComponent(query)}`, [query, scope]);
  const banks = useApiResource<Bank[]>(url, []);

  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Typography.Heading level={1}>题库</Typography.Heading>
        <Link href="/banks/new">新建题库</Link>
      </div>
      <div className="flex flex-wrap gap-2">
        {[['mine', '我的'], ['favorites', '收藏'], ['public', '公开']].map(([value, label]) => (
          <Button key={value} variant={scope === value ? 'primary' : 'secondary'} onPress={() => setScope(value)}>{label}</Button>
        ))}
        <Input aria-label="搜索题库" placeholder="搜索题库" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <PageState loading={banks.loading} error={banks.error} retry={() => void banks.reload()} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {banks.data.map((bank) => (
          <Card key={bank.id}>
            <Card.Header><Typography.Heading level={2}>{bank.name}</Typography.Heading></Card.Header>
            <Card.Content className="grid gap-2">
              <p>{bank.description || '暂无描述'}</p>
              <p className="text-sm text-muted">{bank.subject} · {bank.total_count} 题 · {bank.is_public ? '公开' : '私有'}</p>
              <Link href={`/banks/${bank.id}`}>打开题库</Link>
            </Card.Content>
          </Card>
        ))}
      </div>
      {!banks.loading && !banks.data.length ? <p>没有匹配的题库。</p> : null}
    </section>
  );
}
