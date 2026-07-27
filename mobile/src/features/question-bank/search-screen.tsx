import { router } from 'expo-router';
import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { SectionList } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { RadioGroup } from 'heroui-native/radio-group';
import { Surface } from 'heroui-native/surface';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';

import { Pager } from '@/components/pager';
import { useFocusedLiveQuery } from '@/database';
import { questionTypeLabel } from '@/i18n';
import { useLanguage } from '@/language';
import { LIST_CONTENT_STYLE } from '@/layout';
import { questionSearchPredicate } from '@/search';
import type { Bank, KnowledgePoint, Question } from '@/types';

type Scope = 'all' | 'banks' | 'questions' | 'knowledge';
type SearchBank = Pick<Bank, 'id' | 'subject_name' | 'name' | 'question_count' | 'active_count'>;
type SearchQuestion = Pick<Question, 'id' | 'question_type_code' | 'subject_name' | 'stem' | 'status'> & {
  bank_id: number | null;
  bank_name: string | null;
};
type SearchKnowledgePoint = KnowledgePoint & { subject_name: string; parent_name: string | null };
type SearchResult =
  | { kind: 'bank'; value: SearchBank }
  | { kind: 'question'; value: SearchQuestion }
  | { kind: 'knowledge'; value: SearchKnowledgePoint };
interface SearchSection {
  title: string;
  data: SearchResult[];
}
const PAGE_SIZE = 20;

const SearchResultCard = memo(function SearchResultCard({ result }: { result: SearchResult }) {
  const { language, tr } = useLanguage();
  if (result.kind === 'bank') {
    const bank = result.value;
    return (
      <Card className="gap-3">
        <Chip color="success" variant="soft">{bank.subject_name}</Chip>
        <Typography.Heading type="h3">{bank.name}</Typography.Heading>
        <Typography color="muted">{tr(`${bank.active_count}/${bank.question_count} questions published`, `${bank.active_count}/${bank.question_count} 题已发布`)}</Typography>
        <Button variant="secondary" onPress={() => router.push(`/banks/${bank.id}`)}>{tr('Open', '打开')}</Button>
      </Card>
    );
  }
  if (result.kind === 'question') {
    const question = result.value;
    return (
      <Card className="gap-3">
        <Chip color="default" variant="soft">{questionTypeLabel(question.question_type_code, language)}</Chip>
        <Chip
          color={question.status === 'active' ? 'success' : question.status === 'draft' ? 'warning' : 'default'}
          variant="soft"
        >
          {question.status === 'active' ? tr('Published', '已发布') : question.status === 'draft' ? tr('Draft', '草稿') : tr('Archived', '已归档')}
        </Chip>
        <Typography color="muted">{question.bank_name ?? question.subject_name}</Typography>
        <Typography>{question.stem}</Typography>
        <Button
          variant="ghost"
          onPress={() => router.push({
            pathname: '/questions/[questionId]',
            params: { questionId: String(question.id), ...(question.bank_id ? { bankId: String(question.bank_id) } : {}) },
          })}
        >
          {tr('View question', '查看试题')}
        </Button>
      </Card>
    );
  }
  const point = result.value;
  return (
    <Card>
      <Chip color="success" variant="soft">{point.subject_name}</Chip>
      <Typography.Heading type="h3">{point.name}</Typography.Heading>
      {point.parent_name ? <Typography color="muted">{tr(`Parent: ${point.parent_name}`, `上级：${point.parent_name}`)}</Typography> : null}
    </Card>
  );
});

export default function SearchPage() {
  const { tr } = useLanguage();
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const deferredQuery = useDeferredValue(query.trim());
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(deferredQuery), 200);
    return () => clearTimeout(timer);
  }, [deferredQuery]);
  const like = `%${term}%`;
  const questionSearch = questionSearchPredicate(term);
  const showBanks = scope === 'all' || scope === 'banks';
  const showQuestions = scope === 'all' || scope === 'questions';
  const showKnowledge = scope === 'all' || scope === 'knowledge';

  const banksQuery = useFocusedLiveQuery<SearchBank>(
    `SELECT qb.id, s.name AS subject_name, qb.name,
       COUNT(bql.question_id) AS question_count,
       SUM(CASE WHEN q.status = 'active' THEN 1 ELSE 0 END) AS active_count
     FROM question_banks qb
     JOIN subjects s ON s.id = qb.subject_id
     LEFT JOIN bank_question_links bql ON bql.bank_id = qb.id
     LEFT JOIN questions q ON q.id = bql.question_id
     WHERE ? <> '' AND (qb.name LIKE ? OR s.name LIKE ?)
     GROUP BY qb.id ORDER BY qb.updated_at DESC, qb.id DESC LIMIT ? OFFSET ?`,
    [term, like, like, PAGE_SIZE + 1, page * PAGE_SIZE],
    ['question_banks', 'subjects', 'bank_question_links', 'questions'],
    { enabled: Boolean(term) && showBanks },
  );
  const questionsQuery = useFocusedLiveQuery<SearchQuestion>(
    `SELECT q.id, q.question_type_code, s.name AS subject_name, q.stem, q.status,
       MIN(qb.id) AS bank_id, MIN(qb.name) AS bank_name
     FROM questions q
     JOIN subjects s ON s.id = q.subject_id
     LEFT JOIN bank_question_links bql ON bql.question_id = q.id
     LEFT JOIN question_banks qb ON qb.id = bql.bank_id
     WHERE ? <> '' AND ${questionSearch.sql}
     GROUP BY q.id ORDER BY q.updated_at DESC, q.id DESC LIMIT ? OFFSET ?`,
    [term, questionSearch.value, PAGE_SIZE + 1, page * PAGE_SIZE],
    ['questions', 'questions_fts', 'subjects', 'bank_question_links', 'question_banks'],
    { enabled: Boolean(term) && showQuestions },
  );
  const knowledgeQuery = useFocusedLiveQuery<SearchKnowledgePoint>(
    `SELECT kp.id, kp.name, s.name AS subject_name, parent.name AS parent_name
     FROM knowledge_points kp
     JOIN subjects s ON s.id = kp.subject_id
     LEFT JOIN knowledge_points parent ON parent.id = kp.parent_id
     WHERE ? <> '' AND (kp.name LIKE ? OR s.name LIKE ?)
     ORDER BY s.name, kp.sort_order, kp.name, kp.id LIMIT ? OFFSET ?`,
    [term, like, like, PAGE_SIZE + 1, page * PAGE_SIZE],
    ['knowledge_points', 'subjects'],
    { enabled: Boolean(term) && showKnowledge },
  );
  const banks = banksQuery.data;
  const questions = questionsQuery.data;
  const knowledgePoints = knowledgeQuery.data;
  const queryError = banksQuery.error ?? questionsQuery.error ?? knowledgeQuery.error;

  const visibleBanks = useMemo(() => banks.slice(0, PAGE_SIZE), [banks]);
  const visibleQuestions = useMemo(() => questions.slice(0, PAGE_SIZE), [questions]);
  const visibleKnowledgePoints = useMemo(
    () => knowledgePoints.slice(0, PAGE_SIZE),
    [knowledgePoints],
  );
  const visibleCount = (showBanks ? visibleBanks.length : 0) +
    (showQuestions ? visibleQuestions.length : 0) +
    (showKnowledge ? visibleKnowledgePoints.length : 0);
  const hasNext = (showBanks && banks.length > PAGE_SIZE) ||
    (showQuestions && questions.length > PAGE_SIZE) ||
    (showKnowledge && knowledgePoints.length > PAGE_SIZE);
  const sections = useMemo<SearchSection[]>(() => term ? [
    ...(showBanks && visibleBanks.length ? [{
      title: tr('Banks', '题库'),
      data: visibleBanks.map((value): SearchResult => ({ kind: 'bank', value })),
    }] : []),
    ...(showQuestions && visibleQuestions.length ? [{
      title: tr('Questions', '试题'),
      data: visibleQuestions.map((value): SearchResult => ({ kind: 'question', value })),
    }] : []),
    ...(showKnowledge && visibleKnowledgePoints.length ? [{
      title: tr('Knowledge points', '知识点'),
      data: visibleKnowledgePoints.map((value): SearchResult => ({ kind: 'knowledge', value })),
    }] : []),
  ] : [], [
    showBanks,
    showKnowledge,
    showQuestions,
    term,
    tr,
    visibleBanks,
    visibleKnowledgePoints,
    visibleQuestions,
  ]);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => `${item.kind}:${item.value.id}`}
      renderItem={({ item }) => <SearchResultCard result={item} />}
      renderSectionHeader={({ section }) => (
        <Typography.Heading type="h2">{section.title}</Typography.Heading>
      )}
      ListHeaderComponent={(
        <Surface className="gap-4 rounded-none p-0" variant="transparent">
          <TextField>
            <Label>{tr('Search for', '搜索内容')}</Label>
            <Input
              accessibilityLabel={tr('Search for', '搜索内容')}
              value={query}
              onChangeText={(value) => { setQuery(value); setPage(0); }}
              placeholder={tr('Bank, question text, or knowledge point', '题库、题干或知识点')}
              returnKeyType="search"
              maxLength={200}
            />
          </TextField>
          <Surface className="gap-3" variant="secondary">
            <Typography.Heading type="h2">{tr('Search scope', '搜索范围')}</Typography.Heading>
            <RadioGroup value={scope} onValueChange={(value) => { setScope(value as Scope); setPage(0); }}>
              <RadioGroup.Item value="all">{tr('All', '全部')}</RadioGroup.Item>
              <RadioGroup.Item value="banks">{tr('Banks', '题库')}</RadioGroup.Item>
              <RadioGroup.Item value="questions">{tr('Questions', '试题')}</RadioGroup.Item>
              <RadioGroup.Item value="knowledge">{tr('Knowledge points', '知识点')}</RadioGroup.Item>
            </RadioGroup>
          </Surface>
          {queryError ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{tr('Local search failed. Please try again.', '本地搜索失败，请重试。')}</Alert.Title></Alert.Content>
            </Alert>
          ) : null}
          {!queryError && !term ? (
            <Card><Card.Title>{tr('Enter a keyword to search', '输入关键词开始搜索')}</Card.Title></Card>
          ) : null}
          {!queryError && term && !visibleCount ? (
            <Card><Card.Title>{tr('No matching results', '没有匹配结果')}</Card.Title></Card>
          ) : null}
        </Surface>
      )}
      ListFooterComponent={term && (page > 0 || hasNext) ? (
        <Pager
          page={page}
          hasNext={hasNext}
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
      stickySectionHeadersEnabled={false}
      initialNumToRender={6}
      maxToRenderPerBatch={6}
      windowSize={5}
    />
  );
}
