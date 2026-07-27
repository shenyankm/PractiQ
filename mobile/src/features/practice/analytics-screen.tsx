import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Alert as NativeAlert } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { Typography } from 'heroui-native/text';

import {
  assertCloudAuthorityCurrent,
  CLOUD_API_URL,
  getCloudAuthorityGeneration,
  hasSession,
  learningReportCloud,
  parseLearningReport,
  type LearningReport,
} from '@/cloud';
import { ActivityTrend, type ActivityTrendRow } from '@/components/activity-trend';
import { Pager } from '@/components/pager';
import { ScreenState } from '@/components/screen-state';
import { Section } from '@/components/section';
import { StatCard } from '@/components/stat-card';
import { useFocusedLiveQuery, writeTransaction } from '@/database';
import { formatDate, formatPercent } from '@/i18n';
import { useLanguage } from '@/language';

interface Overview { sessions: number; answers: number; graded: number; correct: number; active_banks: number }
interface BankRow { id: number; name: string; subject_name: string; sessions: number; answers: number; graded: number; correct_count: number }
interface WeakPoint { id: number; name: string; subject_name: string; graded: number; correct: number }
interface ImportQuality { jobs: number; completed: number; failed: number; review_outputs: number; outputs: number; quality: number | null }
interface SavedReport { report: string; created_at: string }
const BANK_PAGE_SIZE = 20;

function readReport(value: string): LearningReport | null {
  try {
    return parseLearningReport(JSON.parse(value));
  } catch {
    return null;
  }
}

export default function AnalyticsPage() {
  const db = useSQLiteContext();
  const { language, tr } = useLanguage();
  const controller = useRef<AbortController | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [bankPage, setBankPage] = useState(0);
  const overviewQuery = useFocusedLiveQuery<Overview>(
    `SELECT COALESCE(SUM(sessions), 0) AS sessions,
       COALESCE(SUM(answers), 0) AS answers,
       COALESCE(SUM(correct_count + incorrect_count), 0) AS graded,
       COALESCE(SUM(correct_count), 0) AS correct,
       COUNT(CASE WHEN answers > 0 THEN 1 END) AS active_banks
     FROM bank_stats`,
    [],
    ['question_banks', 'practice_sessions', 'question_answers'],
  );
  const trendQuery = useFocusedLiveQuery<ActivityTrendRow>(
    `WITH RECURSIVE days(day, n) AS (
       SELECT date('now', 'localtime', '-13 days'), 0
       UNION ALL SELECT date(day, '+1 day'), n + 1 FROM days WHERE n < 13
     ), daily AS (
       SELECT date(submitted_at, 'localtime') AS day, COUNT(*) AS answers,
         SUM(CASE WHEN is_correct IS NOT NULL THEN 1 ELSE 0 END) AS graded,
         SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM question_answers WHERE submitted_at >= datetime('now', '-14 days') GROUP BY day
     )
     SELECT days.day, COALESCE(daily.answers, 0) AS answers, COALESCE(daily.graded, 0) AS graded,
       COALESCE(daily.correct, 0) AS correct
     FROM days LEFT JOIN daily USING(day) ORDER BY days.day`,
    [],
    ['question_answers'],
  );
  const bankQuery = useFocusedLiveQuery<BankRow>(
    `SELECT qb.id, qb.name, s.name AS subject_name, COALESCE(bs.sessions, 0) AS sessions,
       COALESCE(bs.answers, 0) AS answers,
       COALESCE(bs.correct_count + bs.incorrect_count, 0) AS graded,
       COALESCE(bs.correct_count, 0) AS correct_count
     FROM question_banks qb JOIN subjects s ON s.id = qb.subject_id
     LEFT JOIN bank_stats bs ON bs.bank_id = qb.id
     ORDER BY bs.answers DESC, bs.last_practiced_at DESC, qb.updated_at DESC, qb.id DESC
     LIMIT ? OFFSET ?`,
    [BANK_PAGE_SIZE + 1, bankPage * BANK_PAGE_SIZE],
    ['question_banks', 'subjects', 'practice_sessions', 'question_answers'],
  );
  const bankResult = bankQuery.data;
  const bankRows = bankResult.slice(0, BANK_PAGE_SIZE);
  const hasMoreBanks = bankResult.length > BANK_PAGE_SIZE;
  const weakPointsQuery = useFocusedLiveQuery<WeakPoint>(
    `SELECT kp.id, kp.name, s.name AS subject_name,
       SUM(qs.correct_count + qs.incorrect_count) AS graded,
       SUM(qs.correct_count) AS correct
     FROM knowledge_points kp JOIN subjects s ON s.id = kp.subject_id
     JOIN question_knowledge_links qkl ON qkl.knowledge_point_id = kp.id
     JOIN question_stats qs ON qs.question_id = qkl.question_id
     GROUP BY kp.id HAVING SUM(qs.correct_count + qs.incorrect_count) > 0
     ORDER BY CAST(SUM(qs.correct_count) AS REAL) / SUM(qs.correct_count + qs.incorrect_count), graded DESC LIMIT 8`,
    [],
    ['knowledge_points', 'subjects', 'question_answers', 'question_knowledge_links'],
  );
  const importQualityQuery = useFocusedLiveQuery<ImportQuality>(
    `SELECT COUNT(DISTINCT j.id) AS jobs,
       COUNT(DISTINCT CASE WHEN j.status = 'completed' THEN j.id END) AS completed,
       COUNT(DISTINCT CASE WHEN j.status = 'failed' THEN j.id END) AS failed,
       COUNT(o.id) AS outputs, SUM(CASE WHEN o.needs_review = 1 THEN 1 ELSE 0 END) AS review_outputs,
       (SELECT AVG(quality_score) FROM question_import_jobs WHERE quality_score IS NOT NULL) AS quality
     FROM question_import_jobs j LEFT JOIN outputs o ON o.job_id = j.id`,
    [],
    ['question_import_jobs', 'outputs'],
  );
  const savedReports = useFocusedLiveQuery<SavedReport>(
    'SELECT report, created_at FROM learning_reports WHERE id = 1',
    [],
    ['learning_reports'],
  );

  useEffect(() => () => controller.current?.abort(), []);

  const overview = overviewQuery.data[0];
  const trend = trendQuery.data;
  const weakPoints = weakPointsQuery.data;
  const importQuality = importQualityQuery.data[0];
  const queryError = overviewQuery.error ?? trendQuery.error ?? bankQuery.error ?? weakPointsQuery.error ?? importQualityQuery.error;
  const accuracy = overview?.graded ? overview.correct / overview.graded : null;
  const trendAnswers = trend.reduce((total, row) => total + row.answers, 0);
  const savedRow = savedReports.data[0];
  const savedReport = savedRow ? readReport(savedRow.report) : null;

  const generateReport = async () => {
    if (generating) {
      controller.current?.abort();
      return;
    }
    if (!overview?.answers) return NativeAlert.alert(tr('No learning data yet', '暂无学习数据'), tr('Answer at least one question first.', '请先完成至少一次作答。'));

    if (!(await hasSession())) {
      setReportError(tr('Sign in to your PractiQ cloud account first.', '请先登录 PractiQ 云端账户。'));
      return NativeAlert.alert(tr('Not signed in', '尚未登录'), tr('Sign in to your PractiQ cloud account first.', '请先登录 PractiQ 云端账户。'), [
        { text: tr('Cancel', '取消'), style: 'cancel' },
        { text: tr('Open Settings', '打开设置'), onPress: () => router.push('/settings/ai') },
      ]);
    }

    const reportBanks = bankRows.filter((bank) => bank.answers > 0);
    const stats = {
      scope: { trendDays: 14, bankPage: bankPage + 1, bankPageSize: BANK_PAGE_SIZE, weakPointLimit: 8 },
      overview: {
        completedSessions: overview.sessions,
        answers: overview.answers,
        graded: overview.graded,
        correct: overview.correct,
      },
      dailyTrend: trend,
      bankPerformance: reportBanks.map((bank) => ({
        name: bank.name,
        subject: bank.subject_name,
        sessions: bank.sessions,
        answers: bank.answers,
        graded: bank.graded,
        correct: bank.correct_count,
      })),
      weakKnowledgePoints: weakPoints.map((point) => ({
        name: point.name,
        subject: point.subject_name,
        graded: point.graded,
        correct: point.correct,
      })),
      importQuality: {
        jobs: importQuality?.jobs ?? 0,
        completed: importQuality?.completed ?? 0,
        failed: importQuality?.failed ?? 0,
        outputs: importQuality?.outputs ?? 0,
        needsReview: importQuality?.review_outputs ?? 0,
        averageQuality: importQuality?.quality ?? null,
      },
    };

    NativeAlert.alert(
      tr('Send learning statistics to AI?', '发送学习统计到 AI？'),
      tr(
        `Recipient: PractiQ cloud service\nEndpoint: ${CLOUD_API_URL}\n\nThe following will be sent:\n• Total sessions, answers, graded answers, and correct answers\n• Dates and the same answer statistics for each of the past 14 days (${trend.length} days)\n• Names, subjects, sessions, and answer statistics for ${reportBanks.length} active banks on page ${bankPage + 1} of Bank Performance (up to ${BANK_PAGE_SIZE} per page)\n• Names, subjects, and graded-answer statistics for ${weakPoints.length} weak knowledge points (up to 8)\n• Import task, output, review, and quality summaries\n\nQuestion text and personal answers will not be sent; your login credential is used only to authenticate the request.`,
        `接收方：PractiQ 云端服务\n地址：${CLOUD_API_URL}\n\n将发送：\n• 全局会话、作答、已判分、正确数量\n• 近 14 天每天的日期与上述作答统计（${trend.length} 天）\n• 题库表现第 ${bankPage + 1} 页中 ${reportBanks.length} 个活跃题库的名称、学科、会话与作答统计（每页最多 ${BANK_PAGE_SIZE} 个）\n• ${weakPoints.length} 个薄弱知识点的名称、学科与已判分统计（最多 8 个）\n• 导入任务、产物、待复核与质量汇总\n\n不会发送题干或个人答案；登录凭证仅用于请求鉴权。`,
      ),
      [
        { text: tr("Don't Send", '不发送'), style: 'cancel' },
        {
          text: tr('Send', '确认发送'),
          onPress: () => void (async () => {
            const nextController = new AbortController();
            const authorityGeneration = getCloudAuthorityGeneration();
            controller.current = nextController;
            setGenerating(true);
            setReportError(null);
            try {
              const report = await learningReportCloud(stats, {
                abortSignal: nextController.signal,
              });
              await writeTransaction(db, ['learning_reports'], async (transaction) => {
                assertCloudAuthorityCurrent(authorityGeneration);
                await transaction.runAsync(
                  `INSERT INTO learning_reports(id, report) VALUES (1, ?)
                   ON CONFLICT(id) DO UPDATE SET report = excluded.report, created_at = CURRENT_TIMESTAMP`,
                  JSON.stringify(report),
                );
              });
              NativeAlert.alert(tr('Learning report saved', '学习报告已保存'), tr('The report is stored only in the local database.', '报告仅保存在本机数据库中。'));
            } catch (error) {
              setReportError(error instanceof Error ? error.message : String(error));
            } finally {
              controller.current = null;
              setGenerating(false);
            }
          })(),
        },
      ],
    );
  };

  if (overviewQuery.loading) {
    return (
      <ScreenState>
        <Typography.Heading type="h1">{tr('Learning Analytics', '学习分析')}</Typography.Heading>
        <Spinner accessibilityRole="progressbar" accessibilityLabel={tr('Loading analytics', '正在读取分析数据')} />
        <Typography color="muted">{tr('Loading local analytics', '正在读取本地分析数据')}</Typography>
      </ScreenState>
    );
  }

  if (!overviewQuery.error && !overview?.answers) {
    return (
      <ScreenState>
        <Typography.Heading type="h1">{tr('Learning Analytics', '学习分析')}</Typography.Heading>
        {queryError ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{tr('Some local analytics could not be loaded.', '部分本地分析数据读取失败。')}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}
        <Card className="gap-3">
          <Card.Title>{tr('No learning data yet', '暂无学习数据')}</Card.Title>
          <Button onPress={() => router.push('/banks')}>{tr('Start practicing', '开始练习')}</Button>
        </Card>
      </ScreenState>
    );
  }

  return (
    <ScreenState>
        <Typography.Heading type="h1">{tr('Learning Analytics', '学习分析')}</Typography.Heading>
        {queryError ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{tr('Failed to load local analytics. Try again.', '读取本地分析数据失败，请重试。')}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}

        <Section title={tr('Overview', '概览')}>
          <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
            <StatCard className="flex-1" label={tr('Completed', '完成练习')} value={overview?.sessions ?? 0} />
            <StatCard className="flex-1" label={tr('Answers', '累计作答')} value={overview?.answers ?? 0} />
          </Surface>
          <Surface className="flex-row gap-3 rounded-none p-0" variant="transparent">
            <StatCard className="flex-1" label={tr('Accuracy', '客观题正确率')} value={accuracy == null ? '—' : formatPercent(accuracy, language)} hint={tr(`${overview?.graded ?? 0} graded`, `${overview?.graded ?? 0} 次已判分`)} />
            <StatCard className="flex-1" label={tr('Active banks', '活跃题库')} value={overview?.active_banks ?? 0} />
          </Surface>
        </Section>

        <Section title={tr('14-Day Trend', '近 14 天趋势')}>
          {trendAnswers ? <ActivityTrend rows={trend} /> : (
            <Card className="gap-3">
              <Card.Title>{tr('No answers in the last 14 days', '近 14 天暂无作答')}</Card.Title>
              <Button onPress={() => router.push('/banks')}>{tr('Choose a bank', '选择题库')}</Button>
            </Card>
          )}
        </Section>

        <Section title={tr('Bank Performance', '题库表现')}>
          {bankRows.length ? bankRows.map((bank) => (
            <Card className="gap-3" key={bank.id}>
              <Chip>{bank.subject_name}</Chip>
              <Typography.Heading type="h3">{bank.name}</Typography.Heading>
              <Typography>{tr(
                `${bank.sessions} sessions · ${bank.answers} answers · Accuracy on graded answers ${bank.graded ? formatPercent(bank.correct_count / bank.graded, language) : '—'}`,
                `${bank.sessions} 个会话 · ${bank.answers} 次作答 · 已判分正确率 ${bank.graded ? formatPercent(bank.correct_count / bank.graded, language) : '—'}`,
              )}</Typography>
              <Button onPress={() => router.push(`/banks/${bank.id}`)}>{tr('Open', '打开')}</Button>
            </Card>
          )) : (
            <Alert>
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{tr('No bank data yet', '还没有题库数据')}</Alert.Title></Alert.Content>
            </Alert>
          )}
          {bankPage > 0 || hasMoreBanks ? (
            <Pager
              page={bankPage}
              hasNext={hasMoreBanks}
              label={tr(`Page ${bankPage + 1}`, `第 ${bankPage + 1} 页`)}
              onPageChange={setBankPage}
            />
          ) : null}
        </Section>

        <Section title={tr('Weak Knowledge Points', '薄弱知识点')}>
          {weakPoints.length ? weakPoints.map((point) => (
            <Card key={point.id}>
              <Typography.Heading type="h3">{point.name}</Typography.Heading>
              <Typography>{tr(`${point.subject_name} · ${point.graded} graded`, `${point.subject_name} · ${point.graded} 次已判分`)}</Typography>
              <Typography>{formatPercent(point.correct / point.graded, language)}</Typography>
            </Card>
          )) : (
            <Alert>
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{tr('Complete a practice session to see accuracy by knowledge point.', '完成练习后会按知识点显示正确率。')}</Alert.Title></Alert.Content>
            </Alert>
          )}
        </Section>

        <Section title={tr('Import Quality', '导入质量')}>
          <Button onPress={() => router.push('/imports')}>{tr('View Imports', '查看导入')}</Button>
          <StatCard label={tr('Import Tasks', '导入任务')} value={importQuality?.jobs ?? 0} hint={tr(`${importQuality?.completed ?? 0} completed · ${importQuality?.failed ?? 0} failed`, `${importQuality?.completed ?? 0} 完成 · ${importQuality?.failed ?? 0} 失败`)} />
          <StatCard label={tr('Average Quality', '平均质量')} value={importQuality?.quality == null ? '—' : formatPercent(importQuality.quality, language)} />
          <StatCard label={tr('Outputs to Review', '待复核产物')} value={importQuality?.review_outputs ?? 0} hint={tr(`${importQuality?.outputs ?? 0} questions total`, `共 ${importQuality?.outputs ?? 0} 题`)} />
        </Section>

        <Section title={tr('AI Learning Report', 'AI 学习报告')}>
          <Button onPress={() => void generateReport()}>{generating ? tr('Cancel Generation', '取消生成') : tr('Generate AI Report', '生成 AI 报告')}</Button>
          <Alert>
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{tr('AI is optional. Before each request, you will see the recipient, model, and statistics included. Reports are stored locally.', 'AI 是可选功能。每次发送前都会再次列出接收方、模型和统计范围；报告保存于本机。')}</Alert.Title></Alert.Content>
          </Alert>
          {generating ? (
            <Surface accessibilityRole="progressbar" accessibilityLabel={tr('Generating learning report', '正在生成学习报告')}>
              <Spinner />
              <Typography>{tr('Generating the report. Tap “Cancel Generation” to stop the request.', '正在生成报告，可点击“取消生成”中止请求。')}</Typography>
            </Surface>
          ) : null}
          {reportError ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{reportError}</Alert.Title></Alert.Content>
            </Alert>
          ) : null}
          {savedReports.error ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{tr('Failed to load the saved learning report.', '读取已保存学习报告失败。')}</Alert.Title></Alert.Content>
            </Alert>
          ) : null}
          {savedRow && !savedReport ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{tr('The latest learning report has an invalid format. Generate it again.', '最新学习报告格式无效，请重新生成。')}</Alert.Title></Alert.Content>
            </Alert>
          ) : null}
          {savedReport && savedRow ? (
            <Card className="gap-4">
              <Chip>{tr('Saved', '已保存')}</Chip>
              <Typography>{formatDate(savedRow.created_at, language)}</Typography>
              <Typography>{savedReport.summary}</Typography>
              {savedReport.mastery.length ? (
                <Surface className="gap-3 rounded-none p-0" variant="transparent">
                  <Typography.Heading type="h3">{tr('Mastery', '掌握度')}</Typography.Heading>
                  {savedReport.mastery.map((item, index) => (
                    <Surface className="gap-1 rounded-none p-0" key={`${item.area}-${index}`} variant="transparent">
                      <Typography>{item.area} · {formatPercent(item.score, language)}</Typography>
                      <Typography>{item.evidence}</Typography>
                    </Surface>
                  ))}
                </Surface>
              ) : null}
              {savedReport.weakPoints.length ? (
                <Surface className="gap-3 rounded-none p-0" variant="transparent">
                  <Typography.Heading type="h3">{tr('Weak Areas', '薄弱点')}</Typography.Heading>
                  {savedReport.weakPoints.map((item, index) => (
                    <Surface className="gap-1 rounded-none p-0" key={`${item.area}-${index}`} variant="transparent">
                      <Typography>{item.area}</Typography>
                      <Typography>{item.evidence}</Typography>
                    </Surface>
                  ))}
                </Surface>
              ) : null}
              <Surface className="gap-2 rounded-none p-0" variant="transparent">
                <Typography.Heading type="h3">{tr('Recommendations', '建议')}</Typography.Heading>
                {savedReport.recommendations.map((item, index) => (
                  <Typography key={`${item}-${index}`}>{index + 1}. {item}</Typography>
                ))}
              </Surface>
            </Card>
          ) : !savedRow && !savedReports.loading ? (
            <Alert>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{tr('No AI learning report yet', '还没有 AI 学习报告')}</Alert.Title>
                <Alert.Description>{tr('Complete a practice session, then send local summary statistics to generate a report.', '完成练习后可发送本地汇总统计生成报告。')}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
        </Section>
    </ScreenState>
  );
}
