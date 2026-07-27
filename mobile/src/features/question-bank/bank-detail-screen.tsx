import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Alert as NativeAlert } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { Typography } from 'heroui-native/text';

import { ActivityTrend, type ActivityTrendRow } from '@/components/activity-trend';
import { Pager } from '@/components/pager';
import { ScreenState } from '@/components/screen-state';
import { StatCard } from '@/components/stat-card';
import { useFocusedLiveQuery, writeTransaction } from '@/database';
import { deleteQuestionBank } from './actions';
import { pruneOrphanMedia } from '@/files/media';
import { deleteManagedImportFiles, pruneOrphanImportFiles } from '@/files/sandbox';
import { formatDate, formatPercent, questionTypeLabel } from '@/i18n';
import { useLanguage } from '@/language';
import type { PracticeMode, Question } from '@/types';

interface BankDetail {
  name: string;
  description: string;
  subject_name: string;
  is_favorite: number;
  question_count: number;
  active_count: number;
  sessions: number;
  graded: number;
  correct_count: number;
  updated_at: string;
}

type QuestionPreviewRow = Pick<Question, 'id' | 'question_type_code' | 'stem' | 'status'>;

interface SessionHistoryRow {
  id: number;
  mode: PracticeMode;
  status: 'active' | 'completed' | 'abandoned';
  total_questions: number;
  answered_count: number;
  correct_count: number;
  incorrect_count: number;
  started_at: string;
}

const SESSION_PAGE_SIZE = 20;

export default function BankDetailPage() {
  const db = useSQLiteContext();
  const { language, tr } = useLanguage();
  const { bankId: rawBankId } = useLocalSearchParams<{ bankId: string }>();
  const bankId = Number(rawBankId);
  const [sessionPage, setSessionPage] = useState(0);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const bankQuery = useFocusedLiveQuery<BankDetail>(
    `SELECT qb.name, qb.description, s.name AS subject_name, qb.is_favorite, qb.updated_at,
       COUNT(DISTINCT bql.question_id) AS question_count,
       COUNT(DISTINCT CASE WHEN q.status = 'active' THEN q.id END) AS active_count,
       COALESCE(bs.sessions, 0) AS sessions,
       COALESCE(bs.correct_count + bs.incorrect_count, 0) AS graded,
       COALESCE(bs.correct_count, 0) AS correct_count
     FROM question_banks qb
     JOIN subjects s ON s.id = qb.subject_id
     LEFT JOIN bank_question_links bql ON bql.bank_id = qb.id
     LEFT JOIN questions q ON q.id = bql.question_id
     LEFT JOIN bank_stats bs ON bs.bank_id = qb.id
     WHERE qb.id = ? GROUP BY qb.id`,
    [bankId],
    ['question_banks', 'subjects', 'bank_question_links', 'questions', 'practice_sessions', 'question_answers'],
  );
  const questionsQuery = useFocusedLiveQuery<QuestionPreviewRow>(
    `SELECT q.id, q.question_type_code, q.stem, q.status
     FROM bank_question_links bql
     JOIN questions q ON q.id = bql.question_id
     WHERE bql.bank_id = ? ORDER BY bql.sort_order, q.id LIMIT 8`,
    [bankId],
    ['questions', 'bank_question_links'],
  );
  const trendQuery = useFocusedLiveQuery<ActivityTrendRow>(
    `WITH RECURSIVE days(day, n) AS (
       SELECT date('now', 'localtime', '-13 days'), 0
       UNION ALL SELECT date(day, '+1 day'), n + 1 FROM days WHERE n < 13
     ), daily AS (
       SELECT date(qa.submitted_at, 'localtime') AS day, COUNT(*) AS answers,
         SUM(CASE WHEN qa.is_correct IS NOT NULL THEN 1 ELSE 0 END) AS graded,
         SUM(CASE WHEN qa.is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM question_answers qa
       JOIN practice_sessions ps ON ps.id = qa.session_id
       WHERE ps.bank_id = ? AND qa.submitted_at >= datetime('now', '-14 days')
       GROUP BY day
     )
     SELECT days.day, COALESCE(daily.answers, 0) AS answers,
       COALESCE(daily.graded, 0) AS graded, COALESCE(daily.correct, 0) AS correct
     FROM days LEFT JOIN daily USING(day) ORDER BY days.day`,
    [bankId],
    ['question_answers', 'practice_sessions'],
  );
  const sessionsQuery = useFocusedLiveQuery<SessionHistoryRow>(
    `SELECT id, mode, status, total_questions, answered_count, correct_count, incorrect_count, started_at
     FROM practice_sessions WHERE bank_id = ?
     ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
    [bankId, SESSION_PAGE_SIZE + 1, sessionPage * SESSION_PAGE_SIZE],
    ['practice_sessions'],
  );
  const bank = bankQuery.data[0];
  const questions = questionsQuery.data;
  const trend = trendQuery.data;
  const trendAnswers = trend.reduce((total, row) => total + row.answers, 0);
  const modeNames: Record<PracticeMode, string> = {
    all: tr('All questions', '全部练习'),
    wrong: tr('Retry incorrect', '错题重练'),
    type: tr('By question type', '按题型'),
    exam: tr('Exam mode', '考试模式'),
  };

  if (bankQuery.loading || trendQuery.loading) {
    return (
      <ScreenState>
        <Typography.Heading>{tr('Bank', '题库')}</Typography.Heading>
        <Spinner />
        <Typography color="muted">{tr('Loading bank', '正在加载题库')}</Typography>
      </ScreenState>
    );
  }
  if (bankQuery.error || questionsQuery.error || trendQuery.error || sessionsQuery.error) {
    return (
      <ScreenState>
        <Typography.Heading>{tr('Bank', '题库')}</Typography.Heading>
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{(bankQuery.error ?? questionsQuery.error ?? trendQuery.error ?? sessionsQuery.error)?.message ?? tr('Failed to load bank', '读取题库失败')}</Alert.Title>
          </Alert.Content>
        </Alert>
      </ScreenState>
    );
  }

  if (!bank) {
    return (
      <ScreenState className="rounded-none">
        <Card className="gap-3">
          <Card.Title>{tr('Bank not found', '题库不存在')}</Card.Title>
          <Button onPress={() => router.replace('/banks')}>{tr('Back to banks', '返回题库')}</Button>
        </Card>
      </ScreenState>
    );
  }

  const toggleFavorite = async () => {
    if (favoriteBusy) return;
    setFavoriteBusy(true);
    try {
      const result = await writeTransaction(db, ['question_banks'], (transaction) => transaction.runAsync(
        'UPDATE question_banks SET is_favorite = 1 - is_favorite, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        bankId,
      ));
      if (result.changes !== 1) throw new Error(tr('The bank no longer exists.', '题库已不存在。'));
    } catch (reason) {
      NativeAlert.alert(
        tr('Could not update favorite', '无法更新收藏状态'),
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setFavoriteBusy(false);
    }
  };
  const remove = () => NativeAlert.alert(
    tr('Delete bank?', '删除题库？'),
    tr('The bank and related data belonging only to it will be deleted. This cannot be undone.', '题库及仅属于该题库的关联数据将被删除。此操作无法撤销。'),
    [
      { text: tr('Cancel', '取消'), style: 'cancel' },
      {
        text: tr('Delete', '删除'),
        style: 'destructive',
        onPress: () => void (async () => {
          const importUris = await deleteQuestionBank(db, bankId);
          const failedImportFiles = await deleteManagedImportFiles(importUris);
          await pruneOrphanImportFiles(db);
          await pruneOrphanMedia(db);
          router.replace('/banks');
          if (failedImportFiles) {
            NativeAlert.alert(tr('Bank deleted', '题库已删除'), tr('Some imported source files could not be removed. PractiQ will try again the next time it starts.', '部分导入源文件暂时无法移除，PractiQ 会在下次启动时再次清理。'));
          }
        })().catch((error: unknown) => {
          NativeAlert.alert(tr('Delete failed', '删除失败'), error instanceof Error ? error.message : String(error));
        }),
      },
    ],
  );

  return (
    <ScreenState>
        <Stack.Screen options={{ title: bank.name }} />
        <Typography color="muted">
          {tr(`${bank.subject_name} · Updated ${formatDate(bank.updated_at, language)}`, `${bank.subject_name} · 更新于 ${formatDate(bank.updated_at, language)}`)}
        </Typography>
        <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
          <Button className="flex-1" isDisabled={!bank.active_count} onPress={() => router.push(`/banks/${bankId}/practice`)}>
            {tr('Start practice', '开始练习')}
          </Button>
          <Button className="flex-1" isDisabled={favoriteBusy} variant="secondary" onPress={() => void toggleFavorite()}>
            {favoriteBusy
              ? tr('Updating…', '正在更新…')
              : bank.is_favorite ? tr('Unfavorite', '取消收藏') : tr('Favorite', '收藏')}
          </Button>
        </Surface>
        {bank.description ? <Typography>{bank.description}</Typography> : null}

        <Typography.Heading type="h2">{tr('Overview', '概览')}</Typography.Heading>
        <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
          <StatCard className="flex-1" label={tr('All questions', '全部试题')} value={String(bank.question_count)} />
          <StatCard className="flex-1" label={tr('Published', '已发布')} value={String(bank.active_count)} />
        </Surface>
        <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
          <StatCard className="flex-1" label={tr('Sessions', '练习会话')} value={String(bank.sessions)} />
          <StatCard className="flex-1" label={tr('Accuracy', '客观题正确率')} value={bank.graded ? formatPercent(bank.correct_count / bank.graded, language) : '—'} />
        </Surface>

        <Typography.Heading type="h2">{tr('Bank content', '题库内容')}</Typography.Heading>
        <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
          <Button className="flex-1" variant="secondary" onPress={() => router.push(`/banks/${bankId}/manage`)}>
            {tr('Manage', '管理试题')}
          </Button>
          <Button className="flex-1" variant="secondary" onPress={() => router.push({ pathname: '/imports', params: { bankId: String(bankId) } })}>
            {tr('Import', '导入文档')}
          </Button>
        </Surface>

        <Typography.Heading type="h2">{tr('Last 14 days', '近 14 天表现')}</Typography.Heading>
        {trendAnswers ? <ActivityTrend rows={trend} /> : (
          <Card className="gap-3">
            <Card.Title>{tr('No recent practice', '近 14 天暂无练习')}</Card.Title>
            <Button isDisabled={!bank.active_count} onPress={() => router.push(`/banks/${bankId}/practice`)}>
              {tr('Start practice', '开始练习')}
            </Button>
          </Card>
        )}

        <Typography.Heading type="h2">{tr('Practice history', '练习记录')}</Typography.Heading>
        {sessionsQuery.loading ? (
          <Surface>
            <Spinner />
            <Typography color="muted">{tr('Loading practice history', '正在加载练习记录')}</Typography>
          </Surface>
        ) : sessionsQuery.data.length ? (
          <>
            {sessionsQuery.data.slice(0, SESSION_PAGE_SIZE).map((session) => (
              <Card className="gap-3" key={session.id}>
                <Chip color={session.status === 'completed' ? 'success' : session.status === 'active' ? 'warning' : 'default'} variant="soft">
                  {session.status === 'completed' ? tr('Completed', '已完成') : session.status === 'active' ? tr('In progress', '进行中') : tr('Abandoned', '已放弃')}
                </Chip>
                <Typography>{modeNames[session.mode]}</Typography>
                <Typography color="muted">
                  {tr(`${formatDate(session.started_at, language)} · Answered ${session.answered_count}/${session.total_questions}`, `${formatDate(session.started_at, language)} · 已答 ${session.answered_count}/${session.total_questions}`)}
                  {session.status === 'active' ? '' : tr(` · Objective: ${session.correct_count} correct / ${session.incorrect_count} incorrect`, ` · 客观题 ${session.correct_count} 对 / ${session.incorrect_count} 错`)}
                </Typography>
                <Button
                  variant={session.status === 'active' ? 'secondary' : 'ghost'}
                  onPress={() => router.push(`/practice/${session.id}`)}
                >
                  {session.status === 'active' ? tr('Continue', '继续') : tr('View results', '查看结果')}
                </Button>
              </Card>
            ))}
            {sessionPage > 0 || sessionsQuery.data.length > SESSION_PAGE_SIZE ? (
              <Pager
                page={sessionPage}
                hasNext={sessionsQuery.data.length > SESSION_PAGE_SIZE}
                label={tr(`Page ${sessionPage + 1}`, `第 ${sessionPage + 1} 页`)}
                onPageChange={setSessionPage}
                buttonVariant="ghost"
                muted
              />
            ) : null}
          </>
        ) : <Typography color="muted">{tr('No practice history yet.', '尚无练习记录。')}</Typography>}

        <Typography.Heading type="h2">{tr('Question preview', '试题预览')}</Typography.Heading>
        <Button variant="ghost" onPress={() => router.push(`/banks/${bankId}/manage`)}>
          {tr('Manage all', '全部管理')}
        </Button>
        {questions.length ? questions.map((question, index) => (
          <Card className="gap-3" key={question.id}>
            <Chip variant="secondary">{String(index + 1)}</Chip>
            <Chip>{questionTypeLabel(question.question_type_code, language)}</Chip>
            <Chip color={question.status === 'active' ? 'success' : question.status === 'draft' ? 'warning' : 'default'} variant="soft">
              {question.status === 'active' ? tr('Published', '已发布') : question.status === 'draft' ? tr('Draft', '草稿') : tr('Archived', '已归档')}
            </Chip>
            <Typography numberOfLines={2}>{question.stem}</Typography>
            <Button variant="ghost" onPress={() => router.push(`/questions/${question.id}?bankId=${bankId}`)}>
              {tr('View', '查看')}
            </Button>
          </Card>
        )) : (
          <Card>
            <Card.Title>{tr('This bank is empty', '题库还是空的')}</Card.Title>
          </Card>
        )}

        <Button variant="ghost" onPress={() => router.push(`/banks/new?bankId=${bankId}`)}>
          {tr('Edit bank', '编辑题库')}
        </Button>
        <Button variant="danger" onPress={remove}>{tr('Delete bank', '删除题库')}</Button>
    </ScreenState>
  );
}
