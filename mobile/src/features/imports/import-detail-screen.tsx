import { router, Stack, useLocalSearchParams } from 'expo-router';
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

import { Pager } from '@/components/pager';
import { ScreenState } from '@/components/screen-state';
import { Section } from '@/components/section';
import { StatCard } from '@/components/stat-card';
import { useFocusedLiveQuery } from '@/database';
import { formatDate, importStatusLabel, importStatusText, questionTypeLabel } from '@/i18n';
import { IMPORT_STAGE } from '@/import-status';
import { confirmAiImport } from './confirm-ai-import';
import {
  cancelImport,
  retryImport,
  setImportOutputNeedsReview,
} from './runtime';
import { useLanguage } from '@/language';
import type { ImportJob } from '@/types';

interface ImportJobDetail extends ImportJob {
  source_mime_type: string;
  source_size: number;
  source_metadata_json: string | null;
  next_retry_at: string | null;
  output_count: number;
  review_count: number;
}

interface ImportOutputRow {
  id: number;
  question_id: number | null;
  source_index: number;
  confidence: number;
  needs_review: number;
  stem: string | null;
  question_type_code: string | null;
}

interface SourceMetadata {
  parsedTextCharacters?: number;
}

const PAGE_SIZE = 20;

function parseSourceMetadata(value: string | null): SourceMetadata {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as SourceMetadata) : {};
  } catch {
    return {};
  }
}

function fileSize(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

export default function ImportDetailPage() {
  const db = useSQLiteContext();
  const { language, tr } = useLanguage();
  const { jobId: rawJobId } = useLocalSearchParams<{ jobId: string }>();
  const jobId = Number(rawJobId);
  const validJobId = Number.isInteger(jobId) && jobId > 0;
  const queryJobId = validJobId ? jobId : -1;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outputPage, setOutputPage] = useState(0);
  const [reviewingOutputId, setReviewingOutputId] = useState(0);

  const jobQuery = useFocusedLiveQuery<ImportJobDetail>(
    `SELECT j.id, j.bank_id, b.name AS bank_name, j.file_name, j.file_type,
        j.source_mime_type, j.source_size, j.source_metadata_json,
        j.parser, j.ai_profile, j.status, j.progress, j.stage, j.retry_count, j.next_retry_at, j.error,
       j.quality_score, j.created_at,
       COUNT(o.id) AS output_count,
       COALESCE(SUM(CASE WHEN o.needs_review = 1 THEN 1 ELSE 0 END), 0) AS review_count
     FROM question_import_jobs j
     JOIN question_banks b ON b.id = j.bank_id
     LEFT JOIN outputs o ON o.job_id = j.id
     WHERE j.id = ? GROUP BY j.id`,
    [queryJobId],
    ['question_import_jobs', 'question_banks', 'outputs'],
  );
  const outputsQuery = useFocusedLiveQuery<ImportOutputRow>(
    `SELECT o.id, o.question_id, o.source_index, o.confidence, o.needs_review,
       q.stem, q.question_type_code
     FROM outputs o
     LEFT JOIN questions q ON q.id = o.question_id
     WHERE o.job_id = ? ORDER BY o.source_index LIMIT ? OFFSET ?`,
    [queryJobId, PAGE_SIZE + 1, outputPage * PAGE_SIZE],
    ['outputs', 'questions'],
  );
  const job = jobQuery.data[0];

  const performAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const performCancel = () => performAction(() => cancelImport(db, jobId));

  const confirmCancel = () => {
    NativeAlert.alert(
      tr('Cancel this import?', '取消这次导入？'),
      tr('Any unfinished batch write will be rolled back. The copied source file and job record will remain so you can retry later.', '尚未完成的批量写入会回滚，已复制的源文件和任务记录会保留，之后仍可重试。'),
      [
        { text: tr('Continue import', '继续导入'), style: 'cancel' },
        { text: tr('Cancel import', '取消导入'), style: 'destructive', onPress: () => void performCancel() },
      ],
    );
  };

  const performRetry = () => performAction(() => retryImport(
    db,
    jobId,
    (details) => confirmAiImport(details, tr, true),
  ));

  const toggleOutputReview = async (output: ImportOutputRow) => {
    setReviewingOutputId(output.id);
    setActionError(null);
    try {
      await setImportOutputNeedsReview(db, jobId, output.id, !output.needs_review);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReviewingOutputId(0);
    }
  };

  if (!validJobId) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Import job', '导入任务') }} />
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{tr('Invalid job ID', '任务编号无效')}</Alert.Title>
            <Alert.Description>{tr('Choose a job again from the import list.', '请从导入任务列表重新选择。')}</Alert.Description>
          </Alert.Content>
        </Alert>
        <Button onPress={() => router.replace('/imports')}>{tr('Back to imports', '返回导入列表')}</Button>
      </ScreenState>
    );
  }

  if (jobQuery.loading) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Import job', '导入任务') }} />
        <Surface accessibilityRole="progressbar" accessibilityLabel={tr('Loading job', '正在加载任务')}>
          <Spinner />
          <Typography>{tr('Loading job', '正在加载任务')}</Typography>
        </Surface>
      </ScreenState>
    );
  }

  if (jobQuery.error) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Import job', '导入任务') }} />
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Title>{jobQuery.error.message}</Alert.Title></Alert.Content>
        </Alert>
      </ScreenState>
    );
  }

  if (!job) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Import job', '导入任务') }} />
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{tr('Import job not found', '导入任务不存在')}</Alert.Title>
            <Alert.Description>{tr('The job may have been deleted with its bank.', '任务可能已随题库删除。')}</Alert.Description>
          </Alert.Content>
        </Alert>
        <Button onPress={() => router.replace('/imports')}>{tr('Back to imports', '返回导入列表')}</Button>
      </ScreenState>
    );
  }

  const canCancel = ['queued', 'running', 'retry_wait'].includes(job.status);
  const canRetry = ['failed', 'cancelled', 'retry_wait'].includes(job.status);
  const metadata = parseSourceMetadata(job.source_metadata_json);

  return (
    <ScreenState>
        <Stack.Screen options={{ title: tr('Import details', '导入详情') }} />
        <Typography.Heading type="h2">{job.file_name}</Typography.Heading>
        <Typography>{job.bank_name} · {formatDate(job.created_at, language)}</Typography>
        {actionError ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{actionError}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}
        {job.error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{importStatusText(job.error, language)}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}
        {job.stage === IMPORT_STAGE.interrupted ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content><Alert.Description>{tr('The app previously exited during processing. The source file and job record remain on this device; select Retry to continue.', '应用上次在处理期间退出。源文件和任务记录仍在本机，请点“重试”继续。')}</Alert.Description></Alert.Content>
          </Alert>
        ) : null}
        <Alert>
          <Alert.Indicator />
          <Alert.Content><Alert.Description>{job.parser === 'ai'
            ? tr('Parser: cloud AI. The recipient and content must be confirmed before every send or retry.', '解析器：云端 AI。每次发送或重试前都要求确认接收方和传输内容。')
            : tr('Parser: deterministic local fallback. This job will not send the document to an external service.', '解析器：本地确定性 local fallback。此任务不会把文档发送到外部服务。')}</Alert.Description></Alert.Content>
        </Alert>

        <Card className="gap-3">
          <Chip>{importStatusLabel(job.status, language)}</Chip>
          <Chip>{job.file_type.toLocaleUpperCase('en-US')}</Chip>
          {job.retry_count ? <Chip>{tr(`Retried ${job.retry_count} ${job.retry_count === 1 ? 'time' : 'times'}`, `已重试 ${job.retry_count} 次`)}</Chip> : null}
          <Typography.Heading type="h2">{importStatusText(job.stage, language)}</Typography.Heading>
          <Typography>{tr(`${importStatusText(job.stage, language)}: ${job.progress}%`, `${importStatusText(job.stage, language)}：${job.progress}%`)}</Typography>
          {job.status === 'retry_wait' && job.next_retry_at ? (
            <Typography>{tr(`Scheduled to retry automatically at ${formatDate(job.next_retry_at, language)}`, `计划于 ${formatDate(job.next_retry_at, language)} 自动重试`)}</Typography>
          ) : null}
          {canCancel ? (
            <Button isDisabled={busy} onPress={confirmCancel}>{busy ? tr('Cancelling…', '正在取消…') : tr('Cancel import', '取消导入')}</Button>
          ) : null}
          {canRetry ? (
            <Button isDisabled={busy} onPress={() => void performRetry()}>{busy ? tr('Scheduling…', '正在安排…') : job.status === 'retry_wait' ? tr('Retry now', '立即重试') : tr('Retry', '重试')}</Button>
          ) : null}
          <Button onPress={() => router.push(`/banks/${job.bank_id}`)}>{tr('Open bank', '打开题库')}</Button>
        </Card>

        <Section title={tr('Import summary', '导入汇总')}>
          <StatCard label={tr('Questions created', '产出题目')} value={job.output_count} />
          <StatCard label={tr('Awaiting review', '待复核')} value={job.review_count} />
          <StatCard label={tr('Quality score', '质量评分')} value={job.quality_score === null ? '—' : `${Math.round(job.quality_score * 100)}%`} />
        </Section>

        <Section title={tr('Source file details', '源文件详情')}>
          <Card>
            <Chip>{job.source_mime_type}</Chip>
            <Typography>{fileSize(job.source_size)}</Typography>
            {metadata.parsedTextCharacters ? <Typography>{tr(`${metadata.parsedTextCharacters} text characters`, `${metadata.parsedTextCharacters} 个文本字符`)}</Typography> : null}
            {job.file_type === 'txt' ? (
              <Typography>{tr('TXT encoding and file header were validated on this device.', 'TXT 文本已在设备内完成编码和文件头校验。')}</Typography>
            ) : null}
          </Card>
        </Section>

        <Section title={tr('Import output', '导入产出')}>
          {outputsQuery.error ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{outputsQuery.error.message}</Alert.Title></Alert.Content>
            </Alert>
          ) : null}
          {outputsQuery.loading ? (
            <Surface accessibilityRole="progressbar" accessibilityLabel={tr('Loading import output', '正在加载导入产出')}>
              <Spinner />
              <Typography>{tr('Loading import output', '正在加载导入产出')}</Typography>
            </Surface>
          ) : outputsQuery.data.length ? (
            outputsQuery.data.slice(0, PAGE_SIZE).map((output) => (
              <Card className="gap-3" key={output.id}>
                <Chip>{output.question_type_code ? questionTypeLabel(output.question_type_code, language) : tr('Question', '题目')}</Chip>
                <Chip>{output.needs_review ? tr('Awaiting review', '待复核') : tr('No review needed', '无需复核')}</Chip>
                <Typography>{tr(`Confidence ${Math.round(output.confidence * 100)}%`, `置信度 ${Math.round(output.confidence * 100)}%`)}</Typography>
                <Typography numberOfLines={3}>{output.source_index + 1}. {output.stem ?? tr('Linked question deleted', '关联题目已删除')}</Typography>
                <Button
                  isDisabled={reviewingOutputId !== 0}
                  onPress={() => void toggleOutputReview(output)}
                  accessibilityLabel={output.needs_review
                    ? tr(`Mark imported question ${output.source_index + 1} as reviewed`, `将第 ${output.source_index + 1} 道导入题目标记为已复核`)
                    : tr(`Add imported question ${output.source_index + 1} to review`, `将第 ${output.source_index + 1} 道导入题目加入复核`)}
                >
                  {reviewingOutputId === output.id
                    ? tr('Saving…', '保存中…')
                    : output.needs_review ? tr('Mark reviewed', '标记已复核') : tr('Add to review', '加入复核')}
                </Button>
                <Button
                  isDisabled={!output.question_id}
                  onPress={() => {
                    if (output.question_id) router.push(`/questions/${output.question_id}`);
                  }}
                  accessibilityLabel={tr(`View imported question ${output.source_index + 1}`, `查看第 ${output.source_index + 1} 道导入题目`)}
                >
                  {tr('View question', '查看题目')}
                </Button>
              </Card>
            ))
          ) : (
            <Alert>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{job.status === 'completed' ? tr('No import output', '没有导入产出') : tr('Questions have not been written yet', '题目尚未写入')}</Alert.Title>
                <Alert.Description>{tr('The batch write completes in a single transaction; failures and cancellations do not leave a partial batch.', '批量写入会在同一事务中完成；失败或取消不会留下半批题目。')}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}
          {outputPage > 0 || outputsQuery.data.length > PAGE_SIZE ? (
            <Pager
              page={outputPage}
              hasNext={outputsQuery.data.length > PAGE_SIZE}
              label={tr(`Page ${outputPage + 1}`, `第 ${outputPage + 1} 页`)}
              onPageChange={setOutputPage}
            />
          ) : null}
        </Section>

    </ScreenState>
  );
}
