import { router } from 'expo-router';
import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { FlatList } from 'react-native';
import { Accordion } from 'heroui-native/accordion';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { RadioGroup } from 'heroui-native/radio-group';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';

import { Pager } from '@/components/pager';
import { useFocusedLiveQuery } from '@/database';
import { useLanguage } from '@/language';
import { LIST_CONTENT_STYLE } from '@/layout';
import type { Bank } from '@/types';

type Scope = 'all' | 'favorite';
type Sort = 'updated' | 'name' | 'size';
const PAGE_SIZE = 30;

const BankCard = memo(function BankCard({ bank }: { bank: Bank }) {
  const { tr } = useLanguage();
  return (
    <Card className="gap-3">
      <Surface className="flex-row gap-2 rounded-none p-0" variant="transparent">
        <Chip color="success" variant="soft">{bank.subject_name}</Chip>
        {bank.is_favorite ? <Chip color="default" variant="soft">{tr('Favorite', '收藏')}</Chip> : null}
      </Surface>
      <Typography.Heading type="h3">{bank.name}</Typography.Heading>
      <Typography>{tr(`${bank.active_count}/${bank.question_count} questions published`, `${bank.active_count}/${bank.question_count} 题已发布`)}</Typography>
      <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
        <Button className="flex-1" isDisabled={!bank.active_count} onPress={() => router.push(`/banks/${bank.id}/practice`)}>{tr('Practice', '练习')}</Button>
        <Button className="flex-1" variant="secondary" onPress={() => router.push(`/banks/${bank.id}`)}>{tr('View', '查看')}</Button>
      </Surface>
    </Card>
  );
});

export default function BanksPage() {
  const { tr } = useLanguage();
  const [scope, setScope] = useState<Scope>('all');
  const [sort, setSort] = useState<Sort>('updated');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const deferredSearch = useDeferredValue(search.trim());
  const [searchTerm, setSearchTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(deferredSearch), 200);
    return () => clearTimeout(timer);
  }, [deferredSearch]);
  const order = {
    updated: 'qb.updated_at DESC',
    name: 'qb.name COLLATE NOCASE ASC',
    size: 'question_count DESC, qb.updated_at DESC',
  }[sort];
  const favoriteClause = scope === 'favorite' ? 'AND qb.is_favorite = 1' : '';
  const term = `%${searchTerm}%`;
  const { data: banks, loading, error } = useFocusedLiveQuery<Bank>(
    `SELECT qb.id, s.name AS subject_name, qb.name, qb.is_favorite,
       COUNT(bql.question_id) AS question_count,
       SUM(CASE WHEN q.status = 'active' THEN 1 ELSE 0 END) AS active_count
     FROM question_banks qb
     JOIN subjects s ON s.id = qb.subject_id
     LEFT JOIN bank_question_links bql ON bql.bank_id = qb.id
     LEFT JOIN questions q ON q.id = bql.question_id
     WHERE (qb.name LIKE ? OR s.name LIKE ?) ${favoriteClause}
     GROUP BY qb.id ORDER BY ${order} LIMIT ? OFFSET ?`,
    [term, term, PAGE_SIZE + 1, page * PAGE_SIZE],
    ['question_banks', 'subjects', 'bank_question_links', 'questions'],
  );
  const visibleBanks = useMemo(() => banks.slice(0, PAGE_SIZE), [banks]);

  return (
    <FlatList
      data={error ? [] : visibleBanks}
      keyExtractor={(bank) => String(bank.id)}
      renderItem={({ item }) => <BankCard bank={item} />}
      ListHeaderComponent={(
        <Surface className="gap-4 rounded-none p-0" variant="transparent">
        <Typography.Heading type="h1">{tr('Banks', '题库')}</Typography.Heading>
        <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
          <Button className="flex-1" onPress={() => router.push('/banks/new')}>{tr('New bank', '新建题库')}</Button>
          <Button className="flex-1" variant="secondary" onPress={() => router.push('/imports')}>{tr('Import', '导入文档')}</Button>
        </Surface>
        <TextField>
          <Label>{tr('Search banks', '搜索题库')}</Label>
          <Input
            accessibilityLabel={tr('Search banks', '搜索题库')}
            value={search}
            onChangeText={(value) => { setSearch(value); setPage(0); }}
            placeholder={tr('Name or subject', '名称或学科')}
            returnKeyType="search"
            maxLength={100}
          />
        </TextField>
        <Accordion selectionMode="single" variant="surface">
          <Accordion.Item value="filters">
            <Accordion.Trigger>
              <Typography className="flex-1" weight="semibold">{tr('Filter and sort', '筛选与排序')}</Typography>
              <Accordion.Indicator />
            </Accordion.Trigger>
            <Accordion.Content className="gap-3">
              <Typography.Heading type="h3">{tr('Filter', '筛选')}</Typography.Heading>
              <RadioGroup value={scope} onValueChange={(value) => { setScope(value as Scope); setPage(0); }}>
                <RadioGroup.Item value="all">{tr('All', '全部')}</RadioGroup.Item>
                <RadioGroup.Item value="favorite">{tr('Favorites', '收藏')}</RadioGroup.Item>
              </RadioGroup>
              <Typography.Heading type="h3">{tr('Sort', '排序')}</Typography.Heading>
              <RadioGroup value={sort} onValueChange={(value) => { setSort(value as Sort); setPage(0); }}>
                <RadioGroup.Item value="updated">{tr('Recently updated', '最近更新')}</RadioGroup.Item>
                <RadioGroup.Item value="name">{tr('Name', '名称')}</RadioGroup.Item>
                <RadioGroup.Item value="size">{tr('Question count', '题目数量')}</RadioGroup.Item>
              </RadioGroup>
            </Accordion.Content>
          </Accordion.Item>
        </Accordion>

        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{tr('Failed to load banks. Please try again.', '读取题库列表失败，请重试。')}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}
        {!error && loading ? (
          <Surface variant="tertiary">
            <Spinner accessibilityRole="progressbar" accessibilityLabel={tr('Loading banks', '正在读取题库')} />
            <Typography color="muted">{tr('Loading banks', '正在读取题库')}</Typography>
          </Surface>
        ) : null}
        {!error && !loading && !banks.length ? (
          <Card className="gap-3">
            <Card.Title>{scope === 'favorite' ? tr('No favorite banks yet', '还没有收藏题库') : tr('No matching banks', '没有匹配的题库')}</Card.Title>
            <Button onPress={() => router.push('/banks/new')}>{tr('Create bank', '创建题库')}</Button>
          </Card>
        ) : null}
        </Surface>
      )}
      ListFooterComponent={page > 0 || banks.length > PAGE_SIZE ? (
        <Pager
          page={page}
          hasNext={banks.length > PAGE_SIZE}
          label={tr(`Page ${page + 1}`, `第 ${page + 1} 页`)}
          onPageChange={setPage}
          buttonVariant="ghost"
          surfaceVariant="tertiary"
          muted
        />
      ) : null}
      contentContainerStyle={LIST_CONTENT_STYLE}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      initialNumToRender={6}
      maxToRenderPerBatch={6}
      windowSize={5}
    />
  );
}
