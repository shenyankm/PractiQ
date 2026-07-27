import { router } from 'expo-router';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Surface } from 'heroui-native/surface';
import { Typography } from 'heroui-native/text';

import { ScreenState } from '@/components/screen-state';
import { Section } from '@/components/section';
import { StatCard } from '@/components/stat-card';
import { useFocusedLiveQuery } from '@/database';
import { formatPercent } from '@/i18n';
import { useLanguage } from '@/language';
import type { Bank, PracticeSession } from '@/types';

interface Overview {
  banks: number;
  active_questions: number;
  sessions: number;
  graded: number;
  correct: number;
}

type RecentBank = Pick<Bank, 'id' | 'subject_name' | 'name' | 'is_favorite' | 'question_count' | 'active_count'>;
type ActiveSession = Pick<PracticeSession, 'id' | 'bank_name' | 'answered_count' | 'total_questions' | 'exam_mode'>;

interface WeakPoint {
  id: number;
  name: string;
  attempts: number;
  accuracy: number;
}

export default function Dashboard() {
  const { language, tr } = useLanguage();
  const overviewQuery = useFocusedLiveQuery<Overview>(
    `WITH stats AS (
       SELECT COALESCE(SUM(sessions), 0) AS sessions,
         COALESCE(SUM(correct_count + incorrect_count), 0) AS graded,
         COALESCE(SUM(correct_count), 0) AS correct
       FROM bank_stats
     )
     SELECT
       (SELECT COUNT(*) FROM question_banks) AS banks,
       (SELECT COUNT(*) FROM questions WHERE status = 'active') AS active_questions,
       stats.sessions, stats.graded, stats.correct
     FROM stats`,
    [],
    ['question_banks', 'questions', 'practice_sessions', 'question_answers'],
  );
  const recentBanksQuery = useFocusedLiveQuery<RecentBank>(
    `WITH recent AS (
       SELECT qb.id, qb.name, qb.is_favorite, qb.updated_at, s.name AS subject_name
       FROM question_banks qb JOIN subjects s ON s.id = qb.subject_id
       ORDER BY qb.updated_at DESC, qb.id DESC LIMIT 4
     )
     SELECT recent.id, recent.subject_name, recent.name, recent.is_favorite,
       COUNT(bql.question_id) AS question_count,
       SUM(CASE WHEN q.status = 'active' THEN 1 ELSE 0 END) AS active_count
     FROM recent
     LEFT JOIN bank_question_links bql ON bql.bank_id = recent.id
     LEFT JOIN questions q ON q.id = bql.question_id
     GROUP BY recent.id ORDER BY recent.updated_at DESC, recent.id DESC`,
    [],
    ['question_banks', 'subjects', 'bank_question_links', 'questions'],
  );
  const activeSessionsQuery = useFocusedLiveQuery<ActiveSession>(
    `SELECT ps.id, qb.name AS bank_name, ps.answered_count, ps.total_questions, ps.exam_mode
     FROM practice_sessions ps
     JOIN question_banks qb ON qb.id = ps.bank_id
     WHERE ps.status = 'active' ORDER BY ps.started_at DESC LIMIT 2`,
    [],
    ['practice_sessions', 'question_banks'],
  );
  const weakPointsQuery = useFocusedLiveQuery<WeakPoint>(
    `SELECT kp.id, kp.name, SUM(qs.correct_count + qs.incorrect_count) AS attempts,
       CAST(SUM(qs.correct_count) AS REAL) / NULLIF(SUM(qs.correct_count + qs.incorrect_count), 0) AS accuracy
     FROM knowledge_points kp
     JOIN question_knowledge_links qkl ON qkl.knowledge_point_id = kp.id
     JOIN question_stats qs ON qs.question_id = qkl.question_id
     GROUP BY kp.id HAVING SUM(qs.correct_count + qs.incorrect_count) > 0
     ORDER BY accuracy ASC, attempts DESC LIMIT 5`,
    [],
    ['knowledge_points', 'question_answers', 'question_knowledge_links'],
  );

  const overview = overviewQuery.data[0];
  const recentBanks = recentBanksQuery.data;
  const activeSessions = activeSessionsQuery.data;
  const weakPoints = weakPointsQuery.data;
  const queryError = overviewQuery.error ?? recentBanksQuery.error ?? activeSessionsQuery.error ?? weakPointsQuery.error;
  const accuracy = overview?.graded ? overview.correct / overview.graded : null;
  const primarySession = activeSessions[0];

  return (
    <ScreenState>
      <Typography.Heading type="h1">{tr('Keep building today', '今天，继续积累')}</Typography.Heading>
      <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
        <Button
          className="flex-1"
          onPress={() => router.push(primarySession ? `/practice/${primarySession.id}` : '/banks')}
        >
          {primarySession ? tr('Continue practice', '继续练习') : tr('Start practicing', '开始练习')}
        </Button>
        <Button className="flex-1" variant="secondary" onPress={() => router.push('/search')}>{tr('Search', '搜索')}</Button>
      </Surface>

      {queryError ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Title>{tr('Failed to load the local overview. Please try again.', '读取本地概览失败，请重试。')}</Alert.Title></Alert.Content>
        </Alert>
      ) : null}

      <Section title={tr('Overview', '概览')}>
        <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
          <StatCard className="flex-1" label={tr('Banks', '题库')} value={overview?.banks ?? 0} />
          <StatCard className="flex-1" label={tr('Practice-ready', '可练习试题')} value={overview?.active_questions ?? 0} />
        </Surface>
        <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
          <StatCard className="flex-1" label={tr('Completed', '完成会话')} value={overview?.sessions ?? 0} />
          <StatCard className="flex-1" label={tr('Accuracy', '正确率')} value={accuracy == null ? '—' : formatPercent(accuracy, language)} />
        </Surface>
      </Section>

      {activeSessions.length ? (
        <Section title={tr('Continue your last practice', '继续上次练习')}>
          {activeSessions.map((session) => (
            <Card className="gap-3" key={session.id}>
              <Typography.Heading type="h3">{session.bank_name}</Typography.Heading>
              <Typography color="muted">
                {tr(
                  `Answered ${session.answered_count}/${session.total_questions} · ${session.exam_mode ? 'Exam mode' : 'Practice mode'}`,
                  `已答 ${session.answered_count}/${session.total_questions} · ${session.exam_mode ? '考试模式' : '练习模式'}`,
                )}
              </Typography>
              <Button variant="secondary" onPress={() => router.push(`/practice/${session.id}`)}>{tr('Continue', '继续')}</Button>
            </Card>
          ))}
        </Section>
      ) : null}

      <Section title={tr('Recent banks', '最近题库')}>
        <Button variant="ghost" onPress={() => router.push('/banks')}>{tr('View all', '查看全部')}</Button>
        {recentBanks.length ? recentBanks.map((bank) => (
          <Card className="gap-3" key={bank.id}>
            <Chip color="success" variant="soft">{bank.subject_name}</Chip>
            {bank.is_favorite ? <Chip color="default" variant="soft">{tr('Favorite', '已收藏')}</Chip> : null}
            <Typography.Heading type="h3">{bank.name}</Typography.Heading>
            <Typography color="muted">{tr(`${bank.active_count}/${bank.question_count} questions available`, `${bank.active_count}/${bank.question_count} 题可练习`)}</Typography>
            <Button variant="secondary" onPress={() => router.push(`/banks/${bank.id}`)}>{tr('Open bank', '打开题库')}</Button>
          </Card>
        )) : (
          <Card className="gap-3">
            <Card.Title>{tr('No banks yet', '还没有题库')}</Card.Title>
            <Button onPress={() => router.push('/banks/new')}>{tr('Create bank', '创建题库')}</Button>
          </Card>
        )}
      </Section>

      <Section title={tr('Weak knowledge points', '薄弱知识点')}>
        <Button variant="ghost" onPress={() => router.push('/analytics')}>{tr('Detailed analytics', '详细分析')}</Button>
        {weakPoints.length ? weakPoints.map((point) => (
          <Card key={point.id}>
            <Typography weight="semibold">{point.name}</Typography>
            <Typography color="muted">{tr(`${formatPercent(point.accuracy, language)} · ${point.attempts} attempts`, `${formatPercent(point.accuracy, language)} · ${point.attempts} 次`)}</Typography>
          </Card>
        )) : null}
      </Section>
    </ScreenState>
  );
}
