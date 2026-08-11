import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Image, RefreshControl, ScrollView } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';

import { ScreenState } from '@/components/screen-state';
import { Section } from '@/components/section';
import { StatCard } from '@/components/stat-card';
import { languageLabels, type Language } from '@/i18n';
import { useLanguage } from '@/language';
import { CLOUD_API_URL } from '@/cloud';
import { ApiError, apiRequest, mutateOrQueue, uploadImport, type PendingImport } from './api';
import { createMutationKey, enqueueMutation, readResource, writeResource } from './cache';
import { useCloudAuth } from './auth';
import {
  bankGroupsResourceMirror,
  bankItemsResourceMirror,
  bankResourceMirror,
  banksResourceMirror,
  questionDetailResourceMirror,
  questionTypesResourceMirror,
  sessionsResourceMirror,
  subjectsResourceMirror,
  upsertMediaAsset,
} from './mirror';
import {
  analyticsSnapshotSchema,
  analyticsSummarySchema,
  bankGroupsSchema,
  bankItemsSchema,
  bankSchema,
  banksSchema,
  importEventsSchema,
  importJobSchema,
  importJobsSchema,
  importOutputsSchema,
  mediaAssetSchema,
  practicePageSchema,
  practiceAnswerSchema,
  practiceResultsSchema,
  practiceSessionSchema,
  practiceSessionsSchema,
  questionDetailSchema,
  questionTypesSchema,
  searchQuestionsSchema,
  subjectsSchema,
  type AnalyticsSnapshot,
  type AnalyticsSummary,
  type Bank,
  type BankGroup,
  type BankItem,
  type ImportJob,
  type ImportEvent,
  type ImportOutput,
  type MediaAsset,
  type PracticePage,
  type PracticeResult,
  type PracticeSession,
  type QuestionDetail,
  type QuestionType,
  type SearchQuestion,
} from './types';
import { shouldQueueAfterFailure } from './sync-policy';
import { useCachedResource } from './use-resource';

const emptySummary: AnalyticsSummary = {
  owned_banks: 0,
  favorite_banks: 0,
  attempts: 0,
  correct: 0,
  wrong: 0,
  sessions: 0,
  active_sessions: 0,
  active_imports: 0,
  accuracy: 0,
};

const emptySnapshot: AnalyticsSnapshot = {
  summary: emptySummary,
  recentSessions: [],
  weakQuestions: [],
};

function ResourceState({ loading, error }: { loading: boolean; error: string }) {
  if (loading) return <Spinner accessibilityLabel="正在加载" />;
  if (!error) return null;
  return (
    <Alert status="warning">
      <Alert.Indicator />
      <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
    </Alert>
  );
}

function RefreshableScreen({
  children,
  refreshing,
  reload,
}: {
  children: ReactNode;
  refreshing: boolean;
  reload: () => Promise<unknown>;
}) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload()} />}
      showsVerticalScrollIndicator={false}
    >
      <Surface className="gap-4 rounded-none" variant="transparent">{children}</Surface>
    </ScrollView>
  );
}

export function OverviewScreen() {
  const { tr } = useLanguage();
  const { user } = useCloudAuth();
  const summary = useCachedResource('analytics:summary', '/api/v1/analytics/me/summary', emptySummary, analyticsSummarySchema);
  const banks = useCachedResource<Bank[]>('banks:mine', '/api/v1/banks?scope=mine&limit=5', [], banksSchema, true, banksResourceMirror('mine', user?.id ?? null, 5));
  const sessions = useCachedResource<PracticeSession[]>('practice:recent', '/api/v1/practice-sessions?limit=5', [], practiceSessionsSchema, true, sessionsResourceMirror(user?.id ?? null, 5));
  const reload = () => Promise.all([summary.reload(), banks.reload(), sessions.reload()]);

  return (
    <RefreshableScreen refreshing={summary.refreshing || banks.refreshing || sessions.refreshing} reload={reload}>
      <Typography.Heading type="h1">{tr('Overview', '学习概览')}</Typography.Heading>
      <ResourceState loading={summary.loading} error={summary.error} />
      <Surface className="flex-row flex-wrap gap-3 rounded-none p-0" variant="transparent">
        <StatCard className="min-w-36 flex-1" label={tr('Banks', '题库')} value={summary.data.owned_banks} />
        <StatCard className="min-w-36 flex-1" label={tr('Sessions', '练习')} value={summary.data.sessions} />
        <StatCard className="min-w-36 flex-1" label={tr('Answers', '答题')} value={summary.data.attempts} />
        <StatCard className="min-w-36 flex-1" label={tr('Accuracy', '正确率')} value={`${summary.data.accuracy}%`} />
      </Surface>
      <Section title={tr('Recent banks', '最近题库')}>
        {banks.data.map((bank) => (
          <Card key={bank.id} className="gap-2">
            <Card.Title>{bank.name}</Card.Title>
            <Card.Description>{bank.subject} · {bank.total_count} {tr('questions', '题')}</Card.Description>
            <Button onPress={() => router.push(`/banks/${bank.id}`)}>{tr('Open', '打开')}</Button>
          </Card>
        ))}
        {!banks.loading && !banks.data.length ? <Typography color="muted">{tr('No banks yet.', '还没有题库。')}</Typography> : null}
      </Section>
      <Section title={tr('Recent practice', '最近练习')}>
        {sessions.data.map((session) => (
          <Card key={session.id} className="gap-2">
            <Card.Title>#{session.id}</Card.Title>
            <Card.Description>{session.answered_count}/{session.question_count} · {session.status}</Card.Description>
            <Button variant="secondary" onPress={() => router.push(`/practice/${session.id}`)}>{tr('View', '查看')}</Button>
          </Card>
        ))}
      </Section>
    </RefreshableScreen>
  );
}

export function BanksScreen() {
  const { tr } = useLanguage();
  const { user } = useCloudAuth();
  const [scope, setScope] = useState<'mine' | 'favorites' | 'public'>('mine');
  const banks = useCachedResource<Bank[]>(`banks:${scope}`, `/api/v1/banks?scope=${scope}&limit=100`, [], banksSchema, true, banksResourceMirror(scope, user?.id ?? null));

  return (
    <RefreshableScreen refreshing={banks.refreshing} reload={banks.reload}>
      <Typography.Heading type="h1">{tr('Banks', '题库')}</Typography.Heading>
      <Surface className="flex-row gap-2 rounded-none p-0" variant="transparent">
        {(['mine', 'favorites', 'public'] as const).map((value) => (
          <Button
            className="flex-1"
            key={value}
            variant={scope === value ? 'primary' : 'secondary'}
            onPress={() => setScope(value)}
          >
            {{ mine: tr('Mine', '我的'), favorites: tr('Favorites', '收藏'), public: tr('Public', '公开') }[value]}
          </Button>
        ))}
      </Surface>
      <Surface className="flex-row gap-2 rounded-none p-0" variant="transparent">
        <Button className="flex-1" onPress={() => router.push('/banks/new')}>{tr('New bank', '新建题库')}</Button>
        <Button className="flex-1" variant="secondary" onPress={() => router.push('/imports')}>{tr('Import', '导入')}</Button>
      </Surface>
      <ResourceState loading={banks.loading} error={banks.error} />
      {banks.data.map((bank) => (
        <Card key={bank.id} className="gap-3">
          <Surface className="flex-row gap-2 rounded-none p-0" variant="transparent">
            <Chip variant="soft">{bank.subject}</Chip>
            {bank.is_favorite ? <Chip color="success" variant="soft">{tr('Favorite', '已收藏')}</Chip> : null}
            {bank.pending ? <Chip color="warning" variant="soft">{tr('Waiting to sync', '待同步')}</Chip> : null}
          </Surface>
          <Card.Title>{bank.name}</Card.Title>
          <Card.Description>{bank.description || tr('No description', '暂无描述')} · {bank.total_count} {tr('questions', '题')}</Card.Description>
          <Button isDisabled={bank.id < 1} onPress={() => router.push(`/banks/${bank.id}`)}>{tr('Open', '打开')}</Button>
        </Card>
      ))}
      {banks.hasMore ? (
        <Button variant="secondary" isDisabled={banks.loadingMore} onPress={() => void banks.loadMore()}>
          {banks.loadingMore ? tr('Loading…', '加载中…') : tr('Load more', '加载更多')}
        </Button>
      ) : null}
      {!banks.loading && !banks.data.length ? <Typography color="muted">{tr('No matching banks.', '没有匹配的题库。')}</Typography> : null}
    </RefreshableScreen>
  );
}

export function NewBankScreen() {
  const { tr } = useLanguage();
  const { user } = useCloudAuth();
  const banks = useCachedResource<Bank[]>('banks:mine', '/api/v1/banks?scope=mine&limit=100', [], banksSchema, true, banksResourceMirror('mine', user?.id ?? null));
  const subjects = useCachedResource<{ subject_id: string; display_name: string }[]>('subjects', '/api/v1/subjects', [], subjectsSchema, true, subjectsResourceMirror());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('general');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const result = await mutateOrQueue<Bank>('/api/v1/banks', 'POST', {
        name: name.trim(),
        description: description.trim(),
        subject,
        isPublic: false,
      });
      if (result.data) {
        await banks.update([result.data, ...banks.data]);
        router.replace(`/banks/${result.data.id}`);
      } else {
        const optimistic: Bank = {
          id: -Date.now(),
          name: name.trim(),
          description: description.trim(),
          subject,
          total_count: 0,
          is_public: false,
          is_owner: true,
          pending: true,
        };
        await banks.update([optimistic, ...banks.data]);
        setMessage(tr('Saved offline. It will upload when you reconnect.', '已离线保存，联网后会自动上传。'));
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Save failed.', '保存失败。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('New bank', '新建题库')}</Typography.Heading>
      {message ? <Alert status="default"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
      <Card className="gap-4">
        <TextField isDisabled={busy}>
          <Label>{tr('Name', '名称')}</Label>
          <Input value={name} onChangeText={setName} maxLength={100} />
        </TextField>
        <TextField isDisabled={busy}>
          <Label>{tr('Description', '描述')}</Label>
          <Input value={description} onChangeText={setDescription} maxLength={500} />
        </TextField>
        <Typography weight="semibold">{tr('Subject', '学科')}</Typography>
        <Surface className="flex-row flex-wrap gap-2 rounded-none p-0" variant="transparent">
          {(subjects.data.length ? subjects.data : [{ subject_id: 'general', display_name: tr('General', '通用') }]).map((item) => (
            <Button key={item.subject_id} variant={subject === item.subject_id ? 'primary' : 'secondary'} onPress={() => setSubject(item.subject_id)}>
              {item.display_name}
            </Button>
          ))}
        </Surface>
        <Button isDisabled={busy || !name.trim()} onPress={() => void save()}>{busy ? tr('Saving…', '保存中…') : tr('Save', '保存')}</Button>
      </Card>
    </ScreenState>
  );
}

export function BankDetailScreen() {
  const { bankId = '' } = useLocalSearchParams<{ bankId: string }>();
  const { tr } = useLanguage();
  const { user } = useCloudAuth();
  const bank = useCachedResource<Bank>(`bank:${bankId}`, `/api/v1/banks/${bankId}`, {} as Bank, bankSchema, true, bankResourceMirror(Number(bankId), user?.id ?? null));
  const items = useCachedResource<BankItem[]>(`bank:${bankId}:items`, `/api/v1/banks/${bankId}/items?limit=100`, [], bankItemsSchema, true, bankItemsResourceMirror(Number(bankId)));
  const [message, setMessage] = useState('');

  async function favorite() {
    try {
      const next = !bank.data.is_favorite;
      const result = await mutateOrQueue(`/api/v1/banks/${bankId}/favorite`, next ? 'POST' : 'DELETE');
      await bank.update({ ...bank.data, is_favorite: next });
      if (result.queued) setMessage(tr('Favorite change queued.', '收藏变更已加入同步队列。'));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Action failed.', '操作失败。'));
    }
  }

  return (
    <RefreshableScreen refreshing={bank.refreshing || items.refreshing} reload={() => Promise.all([bank.reload(), items.reload()])}>
      <Typography.Heading type="h1">{bank.data.name || tr('Bank', '题库')}</Typography.Heading>
      <Typography>{bank.data.description || tr('No description', '暂无描述')}</Typography>
      {message ? <Alert status="default"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
      <ResourceState loading={bank.loading || items.loading} error={bank.error || items.error} />
      <Surface className="flex-row flex-wrap gap-2 rounded-none p-0" variant="transparent">
        <Button className="flex-1" isDisabled={!items.data.length} onPress={() => router.push(`/banks/${bankId}/practice`)}>{tr('Practice', '练习')}</Button>
        <Button className="flex-1" variant="secondary" onPress={() => void favorite()}>{bank.data.is_favorite ? tr('Unfavorite', '取消收藏') : tr('Favorite', '收藏')}</Button>
        {bank.data.is_owner ? <Button className="flex-1" variant="secondary" onPress={() => router.push(`/banks/${bankId}/manage`)}>{tr('Manage', '管理')}</Button> : null}
      </Surface>
      <Section title={tr('Questions', '题目')}>
        {items.data.map((item, index) => (
          <Card key={`${item.group_id || 0}-${item.question_id}`} className="gap-2">
            <Card.Description>{index + 1} · {item.question_status}</Card.Description>
            <Card.Title>{item.stem}</Card.Title>
            <Button variant="ghost" onPress={() => router.push(`/questions/${item.question_id}`)}>{tr('View', '查看')}</Button>
          </Card>
        ))}
        {items.hasMore ? (
          <Button variant="secondary" isDisabled={items.loadingMore} onPress={() => void items.loadMore()}>
            {items.loadingMore ? tr('Loading…', '加载中…') : tr('Load more', '加载更多')}
          </Button>
        ) : null}
      </Section>
    </RefreshableScreen>
  );
}

export function ManageBankScreen() {
  const { bankId = '' } = useLocalSearchParams<{ bankId: string }>();
  const { tr } = useLanguage();
  const { user } = useCloudAuth();
  const bank = useCachedResource<Bank>(`bank:${bankId}`, `/api/v1/banks/${bankId}`, {} as Bank, bankSchema, true, bankResourceMirror(Number(bankId), user?.id ?? null));
  const items = useCachedResource<BankItem[]>(`bank:${bankId}:manage-items`, `/api/v1/banks/${bankId}/items?limit=100&includeAnswers=true`, [], bankItemsSchema, true, bankItemsResourceMirror(Number(bankId)));
  const groups = useCachedResource<BankGroup[]>(`bank:${bankId}:groups`, `/api/v1/banks/${bankId}/groups?limit=100`, [], bankGroupsSchema, true, bankGroupsResourceMirror(Number(bankId), user?.id ?? null));
  const types = useCachedResource<QuestionType[]>(
    `types:${bank.data.subject || 'general'}`,
    `/api/v1/question-types?subject=${bank.data.subject || 'general'}&scope=question`,
    [],
    questionTypesSchema,
    true,
    questionTypesResourceMirror(bank.data.subject || 'general'),
  );
  const [stem, setStem] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankDescription, setBankDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [answer, setAnswer] = useState('');
  const [optionsText, setOptionsText] = useState('');
  const [typeId, setTypeId] = useState('');
  const [selectedMode, setSelectedMode] = useState<BankItem['answer_mode'] | ''>('');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupInstructions, setGroupInstructions] = useState('');
  const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null);
  const [groupDrafts, setGroupDrafts] = useState<Record<number, { title: string; instructions: string }>>({});
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const type = types.data.find((item) => item.type_id === typeId) || types.data[0];
  const answerMode = selectedMode || type?.default_answer_mode as BankItem['answer_mode'] || 'short_answer';

  useEffect(() => {
    setBankName(bank.data.name || '');
    setBankDescription(bank.data.description || '');
    setIsPublic(Boolean(bank.data.is_public));
  }, [bank.data.description, bank.data.is_public, bank.data.name]);

  async function updateBank() {
    setBusy(true);
    setMessage('');
    try {
      const result = await mutateOrQueue<Bank>(
        `/api/v1/banks/${bankId}`,
        'PATCH',
        {
          name: bankName.trim(),
          description: bankDescription.trim() || null,
          isPublic,
        },
        bankSchema,
      );
      await bank.update({
        ...(result.data || bank.data),
        name: bankName.trim(),
        description: bankDescription.trim() || null,
        is_public: isPublic,
        is_owner: true,
      });
      setMessage(result.queued ? tr('Change queued for sync.', '修改已加入同步队列。') : tr('Saved.', '已保存。'));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Save failed.', '保存失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!type) return;
    const selected = answer.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
    const options = answerMode === 'choice'
      ? optionsText.split('\n').map((value) => value.trim()).filter(Boolean).map((content, index) => {
        const label = String.fromCharCode(65 + index);
        return { label, content, isCorrect: selected.includes(label) };
      })
      : [];
    if (answerMode === 'choice' && (options.length < 2 || !selected.length)) {
      setMessage(tr('Add at least two options and a correct label.', '请至少添加两个选项并填写正确选项标签。'));
      return;
    }
    setBusy(true);
    setMessage('');
    const answerPayload = answerMode === 'true_false'
      ? { value: answer.toLowerCase() === 'true' }
      : answerMode === 'fill_blank'
        ? { value: answer.split('|').map((value) => value.trim()).filter(Boolean) }
        : answerMode === 'choice' ? { selected } : { value: answer };
    try {
      const result = await mutateOrQueue<{ id: number }>(`/api/v1/banks/${bankId}/questions`, 'POST', {
        questionTypeId: type.type_id,
        answerMode,
        choiceVariant: answerMode === 'choice' ? (selected.length > 1 ? 'multiple' : 'single') : undefined,
        stem: stem.trim(),
        analysis: '',
        status: 'draft',
        options,
        answerPayload,
      });
      if (result.data) await items.reload();
      else {
        await items.update([...items.data, {
          question_id: -Date.now(),
          group_id: null,
          stem: stem.trim(),
          answer_mode: answerMode as BankItem['answer_mode'],
          choice_variant: answerMode === 'choice' ? (selected.length > 1 ? 'multiple' : 'single') : null,
          question_type_id: type.type_id,
          question_status: 'draft',
          bank_link_status: 'draft',
          options: [],
        }]);
        setMessage(tr('Question queued for sync.', '题目已加入同步队列。'));
      }
      setStem('');
      setAnswer('');
      setOptionsText('');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Save failed.', '保存失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function createGroup() {
    setBusy(true);
    setMessage('');
    try {
      const result = await mutateOrQueue(`/api/v1/banks/${bankId}/groups`, 'POST', {
        title: groupTitle.trim(),
        instructions: groupInstructions.trim() || null,
        contentMode: 'text_only',
        status: 'draft',
      });
      if (result.data) await groups.reload();
      setGroupTitle('');
      setGroupInstructions('');
      setMessage(result.queued ? tr('Group queued for sync.', '组合题已加入同步队列。') : tr('Group created.', '组合题已创建。'));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Action failed.', '操作失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function groupAction(path: string, method: string, body?: unknown) {
    setBusy(true);
    setMessage('');
    try {
      const result = await mutateOrQueue(path, method, body);
      if (!result.queued) await Promise.all([groups.reload(), items.reload()]);
      setMessage(result.queued ? tr('Change queued for sync.', '修改已加入同步队列。') : tr('Updated.', '已更新。'));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Action failed.', '操作失败。'));
    } finally {
      setBusy(false);
    }
  }

  const standaloneItems = items.data.filter((item) => !item.group_id && item.question_id > 0);

  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('Manage bank', '管理题库')}</Typography.Heading>
      <Typography>{bank.data.name}</Typography>
      {message ? <Alert status="default"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
      <Card className="gap-4">
        <Card.Title>{tr('Bank details', '题库资料')}</Card.Title>
        <TextField isDisabled={busy}>
          <Label>{tr('Name', '名称')}</Label>
          <Input value={bankName} onChangeText={setBankName} maxLength={100} />
        </TextField>
        <TextField isDisabled={busy}>
          <Label>{tr('Description', '描述')}</Label>
          <Input value={bankDescription} onChangeText={setBankDescription} maxLength={500} />
        </TextField>
        <Button variant={isPublic ? 'primary' : 'secondary'} onPress={() => setIsPublic((value) => !value)}>
          {isPublic ? tr('Public bank', '公开题库') : tr('Private bank', '私有题库')}
        </Button>
        <Button isDisabled={busy || !bankName.trim()} onPress={() => void updateBank()}>{tr('Save bank details', '保存题库资料')}</Button>
      </Card>
      <Card className="gap-4">
        <Card.Title>{tr('Add question', '添加题目')}</Card.Title>
        <Typography weight="semibold">{tr('Question type', '题型')}</Typography>
        <Surface className="flex-row flex-wrap gap-2 rounded-none p-0" variant="transparent">
          {types.data.map((item) => (
            <Button
              key={item.type_id}
              variant={type?.type_id === item.type_id ? 'primary' : 'secondary'}
              onPress={() => {
                setTypeId(item.type_id);
                setSelectedMode((item.default_answer_mode as BankItem['answer_mode'] | null) || 'short_answer');
              }}
            >
              {item.display_name}
            </Button>
          ))}
        </Surface>
        <Typography weight="semibold">{tr('Answer mode', '答案类型')}</Typography>
        <Surface className="flex-row flex-wrap gap-2 rounded-none p-0" variant="transparent">
          {(['choice', 'true_false', 'fill_blank', 'short_answer'] as const).map((mode) => (
            <Button key={mode} variant={answerMode === mode ? 'primary' : 'secondary'} onPress={() => setSelectedMode(mode)}>
              {{ choice: tr('Choice', '选择'), true_false: tr('True/false', '判断'), fill_blank: tr('Fill blank', '填空'), short_answer: tr('Short answer', '简答') }[mode]}
            </Button>
          ))}
        </Surface>
        <TextField isDisabled={busy}>
          <Label>{tr('Stem', '题干')}</Label>
          <Input value={stem} onChangeText={setStem} />
        </TextField>
        {answerMode === 'choice' ? (
          <TextField isDisabled={busy}>
            <Label>{tr('Options, one per line', '选项，每行一个')}</Label>
            <Input multiline numberOfLines={4} value={optionsText} onChangeText={setOptionsText} />
          </TextField>
        ) : null}
        {answerMode === 'true_false' ? (
          <Surface className="flex-row gap-2 rounded-none p-0" variant="transparent">
            <Button className="flex-1" variant={answer === 'true' ? 'primary' : 'secondary'} onPress={() => setAnswer('true')}>{tr('True', '正确')}</Button>
            <Button className="flex-1" variant={answer === 'false' ? 'primary' : 'secondary'} onPress={() => setAnswer('false')}>{tr('False', '错误')}</Button>
          </Surface>
        ) : (
          <TextField isDisabled={busy}>
            <Label>{tr('Reference answer', '参考答案')}</Label>
            <Input
              placeholder={answerMode === 'choice' ? tr('A or A,B', '如 A 或 A,B') : answerMode === 'fill_blank' ? tr('Separate blanks with |', '多个空用 | 分隔') : undefined}
              value={answer}
              onChangeText={setAnswer}
            />
          </TextField>
        )}
        <Button isDisabled={busy || !stem.trim() || !answer.trim() || !type} onPress={() => void create()}>{tr('Save draft', '保存草稿')}</Button>
      </Card>
      <Card className="gap-4">
        <Card.Title>{tr('Question groups', '组合题')}</Card.Title>
        <TextField isDisabled={busy}>
          <Label>{tr('Group title', '组合题标题')}</Label>
          <Input value={groupTitle} onChangeText={setGroupTitle} maxLength={1000} />
        </TextField>
        <TextField isDisabled={busy}>
          <Label>{tr('Instructions', '作答说明')}</Label>
          <Input multiline value={groupInstructions} onChangeText={setGroupInstructions} maxLength={20000} />
        </TextField>
        <Button isDisabled={busy || !groupTitle.trim()} onPress={() => void createGroup()}>{tr('Create group', '创建组合题')}</Button>
        <Typography weight="semibold">{tr('Question to move', '要加入的题目')}</Typography>
        <Surface className="gap-2 rounded-none p-0" variant="transparent">
          {standaloneItems.map((item) => (
            <Button key={item.question_id} variant={selectedQuestionId === item.question_id ? 'primary' : 'secondary'} onPress={() => setSelectedQuestionId(item.question_id)}>
              {item.stem}
            </Button>
          ))}
        </Surface>
        {groups.data.map((group) => {
          const draft = groupDrafts[group.id] || { title: group.title || '', instructions: group.instructions || '' };
          return (
            <Surface className="gap-3" key={group.id}>
              <TextField isDisabled={busy}>
                <Label>{tr('Title', '标题')}</Label>
                <Input value={draft.title} onChangeText={(title) => setGroupDrafts((current) => ({ ...current, [group.id]: { ...draft, title } }))} />
              </TextField>
              <TextField isDisabled={busy}>
                <Label>{tr('Instructions', '作答说明')}</Label>
                <Input multiline value={draft.instructions} onChangeText={(instructions) => setGroupDrafts((current) => ({ ...current, [group.id]: { ...draft, instructions } }))} />
              </TextField>
              <Card.Description>{group.status} · {group.question_count} {tr('questions', '题')}</Card.Description>
              <Button isDisabled={busy || !draft.title.trim()} onPress={() => void groupAction(`/api/v1/groups/${group.id}`, 'PATCH', {
                title: draft.title.trim(),
                instructions: draft.instructions.trim() || null,
              })}>{tr('Save group', '保存组合题')}</Button>
              <Button isDisabled={busy || !selectedQuestionId} variant="secondary" onPress={() => void groupAction(`/api/v1/groups/${group.id}/questions`, 'POST', {
                questionId: selectedQuestionId,
              }).then(() => setSelectedQuestionId(null))}>{tr('Move selected question here', '将所选题目加入此组合')}</Button>
              {group.status !== 'active' ? <Button isDisabled={busy} variant="secondary" onPress={() => void groupAction(`/api/v1/groups/${group.id}/publish`, 'POST')}>{tr('Publish group', '发布组合题')}</Button> : null}
              {group.status === 'active' ? <Button isDisabled={busy} variant="secondary" onPress={() => void groupAction(`/api/v1/groups/${group.id}/archive`, 'POST')}>{tr('Archive group', '归档组合题')}</Button> : null}
              <Button
                isDisabled={busy}
                variant="danger"
                onPress={() => confirmDeleteGroup === group.id
                  ? void groupAction(`/api/v1/groups/${group.id}`, 'DELETE').then(() => setConfirmDeleteGroup(null))
                  : setConfirmDeleteGroup(group.id)}
              >
                {confirmDeleteGroup === group.id ? tr('Confirm delete group', '确认删除组合题') : tr('Delete group', '删除组合题')}
              </Button>
              {items.data.filter((item) => item.group_id === group.id).map((item) => (
                <Surface className="flex-row items-center gap-2 rounded-none p-0" key={item.question_id} variant="transparent">
                  <Typography className="flex-1">{item.stem}</Typography>
                  <Button variant="danger" onPress={() => void groupAction(`/api/v1/groups/${group.id}/questions/${item.question_id}`, 'DELETE')}>{tr('Remove', '移出')}</Button>
                </Surface>
              ))}
            </Surface>
          );
        })}
        {groups.hasMore ? (
          <Button variant="secondary" isDisabled={groups.loadingMore} onPress={() => void groups.loadMore()}>
            {groups.loadingMore ? tr('Loading…', '加载中…') : tr('Load more groups', '加载更多组合题')}
          </Button>
        ) : null}
      </Card>
      <Section title={tr('Questions', '题目')}>
        {items.data.map((item) => (
          <Card key={item.question_id} className="gap-2">
            <Card.Title>{item.stem}</Card.Title>
            <Card.Description>{item.question_status}</Card.Description>
            <Button isDisabled={item.question_id < 1} variant="ghost" onPress={() => router.push(`/questions/${item.question_id}`)}>{tr('Edit', '编辑')}</Button>
          </Card>
        ))}
        {items.hasMore ? (
          <Button variant="secondary" isDisabled={items.loadingMore} onPress={() => void items.loadMore()}>
            {items.loadingMore ? tr('Loading…', '加载中…') : tr('Load more', '加载更多')}
          </Button>
        ) : null}
      </Section>
    </ScreenState>
  );
}

export function QuestionScreen() {
  const { questionId = '' } = useLocalSearchParams<{ questionId: string }>();
  const { tr } = useLanguage();
  const auth = useCloudAuth();
  const question = useCachedResource<QuestionDetail>(
    `question:${questionId}`,
    `/api/v1/questions/${questionId}`,
    {} as QuestionDetail,
    questionDetailSchema,
    false,
    questionDetailResourceMirror(Number(questionId), auth.user?.id ?? null),
  );
  const [stem, setStem] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStem(question.data.stem || '');
    setAnalysis(question.data.analysis || '');
  }, [question.data.analysis, question.data.stem]);

  async function save() {
    try {
      const result = await mutateOrQueue(`/api/v1/questions/${questionId}`, 'PATCH', { stem, analysis });
      await question.update({ ...question.data, stem, analysis });
      setMessage(result.queued ? tr('Change queued for sync.', '修改已加入同步队列。') : tr('Saved.', '已保存。'));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Save failed.', '保存失败。'));
    }
  }

  async function transition(action: 'publish' | 'archive') {
    try {
      const result = await mutateOrQueue(`/api/v1/questions/${questionId}/${action}`, 'POST');
      const status = action === 'publish' ? 'active' : 'archived';
      await question.update({ ...question.data, status });
      setMessage(result.queued ? tr('Change queued for sync.', '修改已加入同步队列。') : tr('Updated.', '已更新。'));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Action failed.', '操作失败。'));
    }
  }

  async function generateAnswer() {
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/api/v1/questions/${questionId}/generate-answer`, {
        method: 'POST',
        body: { apply: true },
        idempotencyKey: createMutationKey(),
      });
      await question.reload();
      setMessage(tr('AI answer applied.', 'AI 答案已应用。'));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('AI answer generation failed.', 'AI 答案生成失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function uploadImage() {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = picked.assets?.[0];
    if (picked.canceled || !asset) return;
    setBusy(true);
    setMessage('');
    try {
      const form = new FormData();
      form.append('file', new File(asset.uri));
      const media = await apiRequest<MediaAsset>('/api/v1/media', {
        method: 'POST',
        rawBody: form,
        idempotencyKey: createMutationKey(),
        schema: mediaAssetSchema,
      });
      await upsertMediaAsset(media);
      await apiRequest(`/api/v1/questions/${questionId}/media-links`, {
        method: 'POST',
        body: {
          mediaId: media.id,
          mediaKind: 'image',
          sortOrder: question.data.media_links.length + 1,
        },
        idempotencyKey: createMutationKey(),
      });
      await question.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Upload failed.', '上传失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function unlinkImage(mediaId: number) {
    try {
      await apiRequest(`/api/v1/questions/${questionId}/media-links/${mediaId}`, { method: 'DELETE' });
      await question.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Action failed.', '操作失败。'));
    }
  }

  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('Question', '题目')}</Typography.Heading>
      <ResourceState loading={question.loading} error={question.error} />
      {message ? <Alert status="default"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
      {!question.loading ? (
        <Card className="gap-4">
          <Card.Description>{question.data.question_type_id} · {question.data.answer_mode} · {question.data.status}</Card.Description>
          {!question.data.can_edit ? (
            <>
              <Card.Title>{question.data.stem}</Card.Title>
              {question.data.options.map((option) => <Typography key={option.id}>{option.option_label}. {option.content}</Typography>)}
              {question.data.media_links.map((link) => (
                <Image
                  key={link.id}
                  accessibilityLabel={tr('Question attachment', '题目附件')}
                  source={{
                    uri: `${CLOUD_API_URL}/api/v1/media/${link.media_id}/content`,
                    headers: auth.session ? { Authorization: `Bearer ${auth.session.token}` } : undefined,
                  }}
                  style={{ height: 240, width: '100%', resizeMode: 'contain' }}
                />
              ))}
            </>
          ) : (
            <>
          <TextField>
            <Label>{tr('Stem', '题干')}</Label>
            <Input value={stem} onChangeText={setStem} />
          </TextField>
          <TextField>
            <Label>{tr('Analysis', '解析')}</Label>
            <Input value={analysis} onChangeText={setAnalysis} />
          </TextField>
          <Button onPress={() => void save()}>{tr('Save', '保存')}</Button>
          <Button isDisabled={busy} variant="secondary" onPress={() => void generateAnswer()}>{tr('Generate answer with AI', 'AI 生成答案')}</Button>
          {question.data.status === 'draft' ? <Button variant="secondary" onPress={() => void transition('publish')}>{tr('Publish', '发布')}</Button> : null}
          {question.data.status === 'active' ? <Button variant="secondary" onPress={() => void transition('archive')}>{tr('Archive', '归档')}</Button> : null}
          <Button isDisabled={busy} variant="secondary" onPress={() => void uploadImage()}>{busy ? tr('Uploading…', '上传中…') : tr('Add image', '添加图片')}</Button>
          {question.data.media_links.map((link) => (
            <Surface className="gap-2 rounded-none p-0" key={link.id} variant="transparent">
              <Image
                accessibilityLabel={tr('Question attachment', '题目附件')}
                source={{
                  uri: `${CLOUD_API_URL}/api/v1/media/${link.media_id}/content`,
                  headers: auth.session ? { Authorization: `Bearer ${auth.session.token}` } : undefined,
                }}
                style={{ height: 240, width: '100%', resizeMode: 'contain' }}
              />
              <Button variant="danger" onPress={() => void unlinkImage(link.media_id)}>{tr('Remove image', '移除图片')}</Button>
            </Surface>
          ))}
            </>
          )}
        </Card>
      ) : null}
    </ScreenState>
  );
}

export function AnalyticsScreen() {
  const { tr } = useLanguage();
  const snapshot = useCachedResource(
    'analytics:snapshot',
    '/api/v1/analytics/me/snapshot',
    emptySnapshot,
    analyticsSnapshotSchema,
  );

  return (
    <RefreshableScreen refreshing={snapshot.refreshing} reload={snapshot.reload}>
      <Typography.Heading type="h1">{tr('Analytics', '学习分析')}</Typography.Heading>
      <ResourceState loading={snapshot.loading} error={snapshot.error} />
      <Surface className="flex-row flex-wrap gap-3 rounded-none p-0" variant="transparent">
        <StatCard className="min-w-36 flex-1" label={tr('Answers', '答题')} value={snapshot.data.summary.attempts} />
        <StatCard className="min-w-36 flex-1" label={tr('Correct', '正确')} value={snapshot.data.summary.correct} />
        <StatCard className="min-w-36 flex-1" label={tr('Wrong', '错误')} value={snapshot.data.summary.wrong} />
        <StatCard className="min-w-36 flex-1" label={tr('Accuracy', '正确率')} value={`${snapshot.data.summary.accuracy}%`} />
      </Surface>
      <Section title={tr('Weak questions', '薄弱题目')}>
        {snapshot.data.weakQuestions.map((item) => (
          <Card key={item.question_id} className="gap-2">
            <Card.Title>{item.stem}</Card.Title>
            <Card.Description>{tr(`${item.wrong_count} wrong attempts`, `错误 ${item.wrong_count} 次`)}</Card.Description>
            <Button variant="ghost" onPress={() => router.push(`/questions/${item.question_id}`)}>{tr('Review', '查看')}</Button>
          </Card>
        ))}
      </Section>
    </RefreshableScreen>
  );
}

export function SettingsScreen() {
  const { tr, language, setLanguage } = useLanguage();
  const auth = useCloudAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setUsername(auth.user?.username || auth.session?.username || '');
    setEmail(auth.user?.email || '');
  }, [auth.session?.username, auth.user?.email, auth.user?.username]);

  async function saveProfile() {
    setBusy(true);
    setMessage('');
    try {
      await auth.updateProfile({
        username: username.trim(),
        email: email.trim() || null,
        ...(newPassword ? { currentPassword, newPassword } : {}),
      });
      setCurrentPassword('');
      setNewPassword('');
      setMessage(tr('Account updated.', '账号资料已更新。'));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Save failed.', '保存失败。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('Settings', '设置')}</Typography.Heading>
      <Card className="gap-3">
        <Card.Title>{tr('Account', '账号')}</Card.Title>
        {message ? <Alert status="default"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
        <TextField isDisabled={busy}>
          <Label>{tr('Username', '用户名')}</Label>
          <Input value={username} onChangeText={setUsername} autoCapitalize="none" />
        </TextField>
        <TextField isDisabled={busy}>
          <Label>{tr('Email', '邮箱')}</Label>
          <Input value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        </TextField>
        <TextField isDisabled={busy}>
          <Label>{tr('Current password (only when changing it)', '当前密码（仅修改密码时填写）')}</Label>
          <Input value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry />
        </TextField>
        <TextField isDisabled={busy}>
          <Label>{tr('New password', '新密码')}</Label>
          <Input value={newPassword} onChangeText={setNewPassword} secureTextEntry maxLength={72} />
        </TextField>
        <Button isDisabled={busy || !username.trim()} onPress={() => void saveProfile()}>
          {busy ? tr('Saving…', '保存中…') : tr('Save account', '保存账号资料')}
        </Button>
        <Button variant="danger" onPress={() => void auth.signOut().then(() => router.replace('/sign-in'))}>{tr('Sign out', '退出登录')}</Button>
      </Card>
      <Card className="gap-3">
        <Card.Title>{tr('Offline sync', '离线同步')}</Card.Title>
        <Typography>{tr(`${auth.sync.pending} pending, ${auth.sync.failed} need attention`, `${auth.sync.pending} 项待同步，${auth.sync.failed} 项需要处理`)}</Typography>
        <Button isDisabled={auth.sync.running} onPress={() => void auth.synchronize(auth.sync.failed > 0)}>
          {auth.sync.running ? tr('Syncing…', '同步中…') : tr('Sync now', '立即同步')}
        </Button>
      </Card>
      <Card className="gap-3">
        <Card.Title>{tr('Language', '语言')}</Card.Title>
        <Surface className="flex-row flex-wrap gap-2 rounded-none p-0" variant="transparent">
          {(Object.keys(languageLabels) as Language[]).map((code) => (
            <Button key={code} className="flex-1" variant={language === code ? 'primary' : 'secondary'} onPress={() => void setLanguage(code)}>{languageLabels[code]}</Button>
          ))}
        </Surface>
      </Card>
      <Button variant="ghost" onPress={() => router.push('/privacy')}>{tr('Privacy policy', '隐私政策')}</Button>
    </ScreenState>
  );
}

export function ImportsScreen() {
  const { tr } = useLanguage();
  const { user } = useCloudAuth();
  const jobs = useCachedResource<ImportJob[]>('imports', '/api/v1/import-jobs', [], importJobsSchema);
  const banks = useCachedResource<Bank[]>('banks:mine', '/api/v1/banks?scope=mine&limit=100', [], banksSchema, true, banksResourceMirror('mine', user?.id ?? null));
  const [bankId, setBankId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function pick() {
    if (!bankId) return setMessage(tr('Choose a bank first.', '请先选择题库。'));
    const result = await DocumentPicker.getDocumentAsync({
      type: [
        'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;
    setBusy(true);
    setMessage('');
    let stored: File | null = null;
    try {
      const directory = new Directory(Paths.document, 'cloud-imports');
      directory.create({ idempotent: true, intermediates: true });
      const safeName = `${Date.now()}-${asset.name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}`;
      stored = new File(directory, safeName);
      await new File(asset.uri).copy(stored);
      const input: PendingImport = {
        bankId,
        file: {
          uri: stored.uri,
          name: asset.name,
          type: asset.mimeType || 'application/octet-stream',
        },
      };
      const mutationKey = createMutationKey();
      try {
        const job = await uploadImport(input, mutationKey);
        if (stored.exists) stored.delete();
        stored = null;
        router.push(`/imports/${job.id}`);
      } catch (reason) {
        if (!(reason instanceof ApiError) || !shouldQueueAfterFailure(reason.status, reason.code)) throw reason;
        await enqueueMutation('IMPORT', '/api/v1/import-jobs', input, mutationKey);
        setMessage(tr('Import saved offline and will upload when you reconnect.', '导入文件已离线保存，联网后会自动上传。'));
      }
      await jobs.reload();
    } catch (reason) {
      if (stored?.exists) stored.delete();
      setMessage(reason instanceof Error ? reason.message : tr('Import failed.', '导入失败。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('Document imports', '文档导入')}</Typography.Heading>
      {message ? <Alert status="default"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
      <Card className="gap-3">
        <Card.Title>{tr('New import', '新建导入')}</Card.Title>
        <Typography>{tr('Choose a bank', '选择题库')}</Typography>
        <Surface className="flex-row flex-wrap gap-2 rounded-none p-0" variant="transparent">
          {banks.data.map((bank) => (
            <Button key={bank.id} variant={bankId === bank.id ? 'primary' : 'secondary'} onPress={() => setBankId(bank.id)}>{bank.name}</Button>
          ))}
          {banks.hasMore ? (
            <Button variant="secondary" isDisabled={banks.loadingMore} onPress={() => void banks.loadMore()}>
              {banks.loadingMore ? tr('Loading…', '加载中…') : tr('More banks', '更多题库')}
            </Button>
          ) : null}
        </Surface>
        <Button isDisabled={busy || !bankId} onPress={() => void pick()}>{busy ? tr('Working…', '处理中…') : tr('Choose file', '选择文件')}</Button>
      </Card>
      <Section title={tr('Jobs', '任务')}>
        {jobs.data.map((job) => (
          <Card key={job.id} className="gap-2">
            <Card.Title>{job.file_name || `#${job.id}`}</Card.Title>
            <Card.Description>{job.status} · {job.imported_questions}/{job.total_questions}</Card.Description>
            <Button variant="ghost" onPress={() => router.push(`/imports/${job.id}`)}>{tr('Details', '详情')}</Button>
          </Card>
        ))}
        {jobs.hasMore ? (
          <Button variant="secondary" isDisabled={jobs.loadingMore} onPress={() => void jobs.loadMore()}>
            {jobs.loadingMore ? tr('Loading…', '加载中…') : tr('Load more', '加载更多')}
          </Button>
        ) : null}
      </Section>
    </ScreenState>
  );
}

export function ImportDetailScreen() {
  const { jobId = '' } = useLocalSearchParams<{ jobId: string }>();
  const { tr } = useLanguage();
  const job = useCachedResource<ImportJob>(`import:${jobId}`, `/api/v1/import-jobs/${jobId}`, {} as ImportJob, importJobSchema);
  const events = useCachedResource<ImportEvent[]>(
    `import:${jobId}:events`,
    `/api/v1/import-jobs/${jobId}/events`,
    [],
    importEventsSchema,
  );
  const outputs = useCachedResource<ImportOutput[]>(
    `import:${jobId}:outputs`,
    `/api/v1/import-jobs/${jobId}/outputs`,
    [],
    importOutputsSchema,
  );
  const reloadJob = job.reload;
  const reloadEvents = events.reload;
  const reloadOutputs = outputs.reload;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!job.data.status || ['completed', 'failed', 'cancelled'].includes(job.data.status)) return;
    const timer = setInterval(() => {
      void reloadJob();
      void reloadEvents();
      void reloadOutputs();
    }, 3_000);
    return () => clearInterval(timer);
  }, [job.data.status, reloadEvents, reloadJob, reloadOutputs]);

  async function run(action: 'retry' | 'cancel') {
    setBusy(true);
    setMessage('');
    try {
      const updated = await apiRequest<ImportJob>(`/api/v1/import-jobs/${jobId}/${action}`, {
        method: 'POST',
        schema: importJobSchema,
      });
      await job.update(updated);
      await events.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Action failed.', '操作失败。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenState>
      <Typography.Heading type="h1">{job.data.file_name || tr('Import job', '导入任务')}</Typography.Heading>
      <ResourceState loading={job.loading} error={job.error} />
      {message ? <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
      {job.data.last_error ? <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>{job.data.last_error}</Alert.Title></Alert.Content></Alert> : null}
      <Card className="gap-2">
        <Typography>{tr('Status', '状态')}：{job.data.status}</Typography>
        <Typography>{tr('Stage', '阶段')}：{job.data.stage}</Typography>
        <Typography>{tr('Progress', '进度')}：{Math.round(job.data.overall_progress_percent || 0)}%</Typography>
        {job.data.status === 'failed' ? <Button isDisabled={busy} onPress={() => void run('retry')}>{tr('Retry', '重试')}</Button> : null}
        {['queued', 'processing'].includes(job.data.status) ? <Button isDisabled={busy} variant="danger" onPress={() => void run('cancel')}>{tr('Cancel', '取消')}</Button> : null}
      </Card>
      <Section title={tr('Events', '事件')}>
        {events.data.map((event) => <Typography key={event.id}>{event.status} · {event.message || ''}</Typography>)}
      </Section>
      <Section title={tr('Questions', '生成题目')}>
        {outputs.data.map((output) => (
          <Button key={output.id} variant="ghost" onPress={() => router.push(`/questions/${output.question_id}`)}>#{output.question_id}</Button>
        ))}
      </Section>
    </ScreenState>
  );
}

type OfflinePractice = {
  id: number;
  bankId: number;
  questions: BankItem[];
  index: number;
  answers: { questionId: number; answerPayload: Record<string, unknown> }[];
  startedAt: string;
  queued?: boolean;
};

export function PracticeSetupScreen() {
  const { bankId = '' } = useLocalSearchParams<{ bankId: string }>();
  const { tr } = useLanguage();
  const { user } = useCloudAuth();
  const bank = useCachedResource<Bank>(`bank:${bankId}`, `/api/v1/banks/${bankId}`, {} as Bank, bankSchema, true, bankResourceMirror(Number(bankId), user?.id ?? null));
  // status=active 过滤拉取不是完整集合,禁用 reconcile(只做 upsert,不删除传播)
  const items = useCachedResource<BankItem[]>(`bank:${bankId}:items`, `/api/v1/banks/${bankId}/items?status=active&limit=100`, [], bankItemsSchema, true, bankItemsResourceMirror(Number(bankId), { reconcile: false }));
  const types = useCachedResource<QuestionType[]>(
    `types:${bank.data.subject || 'general'}`,
    `/api/v1/question-types?subject=${bank.data.subject || 'general'}&scope=question`,
    [],
    questionTypesSchema,
    true,
    questionTypesResourceMirror(bank.data.subject || 'general'),
  );
  const [mode, setMode] = useState<'all' | 'wrong' | 'by_type' | 'exam'>('all');
  const [typeId, setTypeId] = useState('');
  const [count, setCount] = useState('20');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selectedTypeId = typeId || types.data[0]?.type_id || '';

  async function start() {
    setBusy(true);
    setMessage('');
    try {
      const session = await apiRequest<PracticeSession>('/api/v1/practice-sessions', {
        method: 'POST',
        body: {
          bankId: Number(bankId),
          sessionType: mode === 'exam' ? 'exam' : mode === 'wrong' ? 'review' : 'practice',
          mode,
          questionCount: Number(count),
          questionTypeId: mode === 'by_type' ? selectedTypeId : undefined,
        },
        schema: practiceSessionSchema,
      });
      router.replace(`/practice/${session.id}`);
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.status !== 0) {
        setMessage(reason instanceof Error ? reason.message : tr('Could not start.', '无法开始练习。'));
        setBusy(false);
        return;
      }
      if (mode !== 'all') {
        setMessage(tr('This practice mode requires a connection.', '此练习模式需要联网。'));
        setBusy(false);
        return;
      }
      const questions = items.data
        .filter((item) => item.question_status === 'active')
        .slice(0, Number(count));
      if (!questions.length) {
        setMessage(tr('Open this bank online once before practicing offline.', '请先联网打开一次题库，再进行离线练习。'));
        setBusy(false);
        return;
      }
      const id = -Date.now();
      await writeResource(`offline-practice:${id}`, {
        id,
        bankId: Number(bankId),
        questions,
        index: 0,
        answers: [],
        startedAt: new Date().toISOString(),
      } satisfies OfflinePractice);
      router.replace(`/practice/${id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('Practice', '练习')} {bank.data.name}</Typography.Heading>
      {message ? <Alert status="warning"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
      <Card className="gap-3">
        {(['all', 'wrong', 'by_type', 'exam'] as const).map((value) => (
          <Button key={value} variant={mode === value ? 'primary' : 'secondary'} onPress={() => setMode(value)}>
            {{ all: tr('All types', '全部题型'), wrong: tr('Wrong questions', '错题重练'), by_type: tr('By type', '按题型'), exam: tr('Exam', '考试模式') }[value]}
          </Button>
        ))}
        {mode === 'by_type' ? (
          <Surface className="flex-row flex-wrap gap-2 rounded-none p-0" variant="transparent">
            {types.data.map((item) => (
              <Button key={item.type_id} variant={selectedTypeId === item.type_id ? 'primary' : 'secondary'} onPress={() => setTypeId(item.type_id)}>
                {item.display_name}
              </Button>
            ))}
          </Surface>
        ) : null}
        <TextField isDisabled={busy}>
          <Label>{tr('Question count', '题目数量')}</Label>
          <Input value={count} onChangeText={setCount} keyboardType="number-pad" />
        </TextField>
        <Button
          isDisabled={busy || !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 500 || (mode === 'by_type' && !selectedTypeId)}
          onPress={() => void start()}
        >
          {busy ? tr('Starting…', '正在开始…') : tr('Start', '开始')}
        </Button>
      </Card>
    </ScreenState>
  );
}

export function PracticeSessionScreen() {
  const { sessionId = '' } = useLocalSearchParams<{ sessionId: string }>();
  return Number(sessionId) < 0
    ? <OfflinePracticeScreen sessionId={Number(sessionId)} />
    : <OnlinePracticeScreen sessionId={Number(sessionId)} />;
}

function answerPayload(question: BankItem, text: string, selected: string[]) {
  if (question.answer_mode === 'choice') return { selected };
  if (question.answer_mode === 'true_false') return { value: text === 'true' };
  if (question.answer_mode === 'fill_blank') return { value: text.split('|').map((value) => value.trim()) };
  return { value: text };
}

function AnswerEditor({
  question,
  text,
  setText,
  selected,
  setSelected,
}: {
  question: BankItem;
  text: string;
  setText: (value: string) => void;
  selected: string[];
  setSelected: (value: string[]) => void;
}) {
  const { tr } = useLanguage();
  if (question.answer_mode === 'choice') {
    return (
      <Surface className="gap-2 rounded-none p-0" variant="transparent">
        {(question.options || []).map((option) => (
          <Button
            key={option.id}
            variant={selected.includes(option.option_label) ? 'primary' : 'secondary'}
            onPress={() => setSelected(question.choice_variant === 'multiple'
              ? selected.includes(option.option_label)
                ? selected.filter((value) => value !== option.option_label)
                : [...selected, option.option_label]
              : [option.option_label])}
          >
            {option.option_label}. {option.content}
          </Button>
        ))}
      </Surface>
    );
  }
  if (question.answer_mode === 'true_false') {
    return (
      <Surface className="flex-row gap-2 rounded-none p-0" variant="transparent">
        <Button className="flex-1" variant={text === 'true' ? 'primary' : 'secondary'} onPress={() => setText('true')}>{tr('True', '正确')}</Button>
        <Button className="flex-1" variant={text === 'false' ? 'primary' : 'secondary'} onPress={() => setText('false')}>{tr('False', '错误')}</Button>
      </Surface>
    );
  }
  return (
    <TextField>
      <Label>{question.answer_mode === 'fill_blank' ? tr('Answer (separate blanks with |)', '答案（多个空用 | 分隔）') : tr('Answer', '答案')}</Label>
      <Input value={text} onChangeText={setText} />
    </TextField>
  );
}

function OfflinePracticeScreen({ sessionId }: { sessionId: number }) {
  const { tr } = useLanguage();
  const [practice, setPractice] = useState<OfflinePractice | null>(null);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void readResource<OfflinePractice>(`offline-practice:${sessionId}`).then(setPractice);
  }, [sessionId]);
  const question = practice?.questions[practice.index];

  async function submit() {
    if (!practice || !question || practice.queued) return;
    let next: OfflinePractice = {
      ...practice,
      index: Math.min(practice.index + 1, practice.questions.length - 1),
      answers: [...practice.answers.filter((item) => item.questionId !== question.question_id), {
        questionId: question.question_id,
        answerPayload: answerPayload(question, text, selected),
      }],
    };
    if (next.answers.length === next.questions.length) {
      await enqueueMutation('POST', '/api/v1/offline-practice', {
        bankId: next.bankId,
        answers: next.answers,
      }, `offline-practice-${Math.abs(sessionId)}`);
      next = { ...next, queued: true };
      setMessage(tr('Practice completed offline and queued for sync.', '离线练习已完成并加入同步队列。'));
    }
    await writeResource(`offline-practice:${sessionId}`, next);
    setPractice(next);
    setText('');
    setSelected([]);
  }

  if (!practice || !question) return <ScreenState><Spinner /></ScreenState>;
  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('Offline practice', '离线练习')}</Typography.Heading>
      <Chip color="warning" variant="soft">{tr('Offline', '离线')}</Chip>
      {message ? <Alert status="success"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
      <Card className="gap-4">
        <Card.Description>{practice.index + 1}/{practice.questions.length}</Card.Description>
        <Card.Title>{question.stem}</Card.Title>
        <AnswerEditor question={question} text={text} setText={setText} selected={selected} setSelected={setSelected} />
        <Button isDisabled={practice.queued} onPress={() => void submit()}>
          {practice.queued
            ? tr('Waiting to sync', '等待同步')
            : practice.index === practice.questions.length - 1 ? tr('Finish', '完成') : tr('Submit and continue', '提交并继续')}
        </Button>
      </Card>
    </ScreenState>
  );
}

function OnlinePracticeScreen({ sessionId }: { sessionId: number }) {
  const { tr } = useLanguage();
  const [index, setIndex] = useState(0);
  const page = useCachedResource<PracticePage>(
    `practice:${sessionId}:page:${index}`,
    `/api/v1/practice-sessions/${sessionId}/question-page?index=${index}`,
    {} as PracticePage,
    practicePageSchema,
    false,
  );
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [results, setResults] = useState<PracticeResult[] | null>(null);
  const question = page.data.question;

  useEffect(() => {
    if (!page.data.session || page.data.session.status === 'active') return;
    let active = true;
    apiRequest<PracticeResult[]>(`/api/v1/practice-sessions/${sessionId}/results`, {
      schema: practiceResultsSchema,
    }).then((value) => {
      if (active) setResults(value);
    }).catch((reason) => {
      if (active) setMessage(reason instanceof Error ? reason.message : tr('Could not load results.', '无法加载练习结果。'));
    });
    return () => { active = false; };
  }, [page.data.session, sessionId, tr]);

  async function submit() {
    if (!question || page.data.result) return;
    setMessage('');
    try {
      const result = await mutateOrQueue(
        `/api/v1/practice-sessions/${sessionId}/answers`,
        'POST',
        {
          questionId: question.question_id,
          answerPayload: answerPayload(question, text, selected),
        },
        practiceAnswerSchema,
      );
      setText('');
      setSelected([]);
      if (result.queued) {
        setMessage(tr('Answer queued for sync.', '答案已加入同步队列。'));
        if (page.data.nextIndex !== null && page.data.nextIndex !== undefined) setIndex(page.data.nextIndex);
      } else {
        setMessage(
          result.data?.is_correct === true
            ? tr('Correct.', '回答正确。')
            : result.data?.is_correct === false
              ? tr('Incorrect. Review the explanation below.', '回答错误，请查看下方解析。')
              : tr('Answer submitted. Results will appear after the exam.', '答案已提交，考试结束后显示结果。'),
        );
        await page.reload();
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Submit failed.', '提交失败。'));
    }
  }

  async function finish() {
    try {
      const result = await mutateOrQueue(
        `/api/v1/practice-sessions/${sessionId}/complete`,
        'POST',
        undefined,
        practiceSessionSchema,
      );
      setMessage(result.queued ? tr('Completion queued for sync.', '完成状态已加入同步队列。') : tr('Practice completed.', '练习已完成。'));
      if (!result.queued) {
        setResults(await apiRequest<PracticeResult[]>(`/api/v1/practice-sessions/${sessionId}/results`, {
          schema: practiceResultsSchema,
        }));
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Action failed.', '操作失败。'));
    }
  }

  async function abandon() {
    try {
      await mutateOrQueue(
        `/api/v1/practice-sessions/${sessionId}/abandon`,
        'POST',
        undefined,
        practiceSessionSchema,
      );
      router.replace('/');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : tr('Action failed.', '操作失败。'));
    }
  }

  if (results) {
    return (
      <ScreenState>
        <Typography.Heading type="h1">{tr('Practice results', '练习结果')}</Typography.Heading>
        {results.map((result, resultIndex) => (
          <Card key={result.id} className="gap-2">
            <Card.Title>{resultIndex + 1}. {result.stem}</Card.Title>
            <Card.Description>
              {result.is_correct === true ? tr('Correct', '正确') : result.is_correct === false ? tr('Incorrect', '错误') : tr('Answered', '已作答')}
            </Card.Description>
            {result.analysis ? <Typography>{result.analysis}</Typography> : null}
          </Card>
        ))}
        <Button onPress={() => router.replace('/')}>{tr('Back to overview', '返回概览')}</Button>
      </ScreenState>
    );
  }

  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('Practice', '练习')}</Typography.Heading>
      <ResourceState loading={page.loading} error={page.error} />
      {message ? <Alert status="default"><Alert.Indicator /><Alert.Content><Alert.Title>{message}</Alert.Title></Alert.Content></Alert> : null}
      {question ? (
        <Card className="gap-4">
          <Card.Description>{page.data.questionIndex + 1}/{page.data.total}</Card.Description>
          <Surface className="flex-row flex-wrap gap-1 rounded-none p-0" variant="transparent">
            {page.data.progress.map((item) => (
              <Button
                key={item.questionId}
                size="sm"
                variant={item.index === page.data.questionIndex ? 'primary' : 'secondary'}
                onPress={() => setIndex(item.index)}
              >
                {item.index + 1}{item.isAnswered ? ' ✓' : ''}
              </Button>
            ))}
          </Surface>
          <Card.Title>{question.stem}</Card.Title>
          <AnswerEditor question={question} text={text} setText={setText} selected={selected} setSelected={setSelected} />
          {question.analysis ? <Typography>{tr('Explanation', '解析')}：{question.analysis}</Typography> : null}
          <Surface className="flex-row gap-2 rounded-none p-0" variant="transparent">
            <Button
              className="flex-1"
              variant="secondary"
              isDisabled={page.data.previousIndex === null || page.data.previousIndex === undefined}
              onPress={() => setIndex(page.data.previousIndex || 0)}
            >
              {tr('Previous', '上一题')}
            </Button>
            <Button className="flex-1" isDisabled={Boolean(page.data.result)} onPress={() => void submit()}>{tr('Submit', '提交')}</Button>
            {page.data.nextIndex !== null && page.data.nextIndex !== undefined ? (
              <Button className="flex-1" variant="secondary" onPress={() => setIndex(page.data.nextIndex!)}>{tr('Next', '下一题')}</Button>
            ) : page.data.result ? (
              <Button className="flex-1" variant="secondary" onPress={() => void finish()}>{tr('Finish', '完成')}</Button>
            ) : null}
          </Surface>
          <Button variant="danger" onPress={() => void abandon()}>{tr('Abandon practice', '放弃练习')}</Button>
        </Card>
      ) : null}
    </ScreenState>
  );
}

export function SearchScreen() {
  const { tr } = useLanguage();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const results = useCachedResource<SearchQuestion[]>(
    `search:questions:${submitted}`,
    `/api/v1/search/questions?q=${encodeURIComponent(submitted)}`,
    [],
    searchQuestionsSchema,
  );
  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('Search', '搜索')}</Typography.Heading>
      <TextField>
        <Label>{tr('Question text', '题目内容')}</Label>
        <Input value={query} onChangeText={setQuery} returnKeyType="search" onSubmitEditing={() => setSubmitted(query.trim())} />
      </TextField>
      <Button isDisabled={!query.trim()} onPress={() => setSubmitted(query.trim())}>{tr('Search', '搜索')}</Button>
      {submitted ? <ResourceState loading={results.loading} error={results.error} /> : null}
      {results.data.map((item) => (
        <Card key={item.id} className="gap-2">
          <Card.Title>{item.stem}</Card.Title>
          <Button variant="ghost" onPress={() => router.push(`/questions/${item.id}`)}>{tr('Open', '打开')}</Button>
        </Card>
      ))}
      {results.hasMore ? (
        <Button variant="secondary" isDisabled={results.loadingMore} onPress={() => void results.loadMore()}>
          {results.loadingMore ? tr('Loading…', '加载中…') : tr('Load more', '加载更多')}
        </Button>
      ) : null}
    </ScreenState>
  );
}
