import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { memo, useMemo, useState } from 'react';
import { FlatList } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { Typography } from 'heroui-native/text';

import { Pager } from '@/components/pager';
import { useFocusedLiveQuery } from '@/database';
import { formatDate, importStatusLabel, importStatusText } from '@/i18n';
import { confirmAiImport } from './confirm-ai-import';
import { MAX_IMPORT_BYTES } from './parser';
import { pickAndQueueImport } from './runtime';
import { useLanguage } from '@/language';
import { LIST_CONTENT_STYLE } from '@/layout';
import type { ImportJob } from '@/types';

interface BankChoice {
  id: number;
  name: string;
  subject_name: string;
}

type ImportListRow = Pick<ImportJob,
  'id' | 'bank_name' | 'file_name' | 'file_type' | 'parser' | 'ai_profile' | 'status' |
  'progress' | 'stage' | 'error' | 'created_at'
> & {
  output_count: number;
  review_count: number;
};

const BANK_PAGE_SIZE = 12;
const JOB_PAGE_SIZE = 30;

const ImportJobCard = memo(function ImportJobCard({ job }: { job: ImportListRow }) {
  const { language, tr } = useLanguage();
  return (
    <Card className="gap-3">
      <Chip>{importStatusLabel(job.status, language)}</Chip>
      <Chip>{job.file_type.toLocaleUpperCase('en-US')}</Chip>
      <Chip>{job.parser === 'ai' ? tr('Cloud AI', '云端 AI') : tr('Offline', '离线')}</Chip>
      <Typography>{job.bank_name}</Typography>
      <Typography.Heading type="h3" numberOfLines={2}>{job.file_name}</Typography.Heading>
      <Typography>{importStatusText(job.stage, language)} · {formatDate(job.created_at, language)}</Typography>
      <Typography>{tr(`${importStatusText(job.stage, language)}: ${job.progress}%`, `${importStatusText(job.stage, language)}：${job.progress}%`)}</Typography>
      {job.output_count ? <Typography>{tr(`${job.output_count} ${job.output_count === 1 ? 'question' : 'questions'}`, `${job.output_count} 道题`)}</Typography> : null}
      {job.review_count ? <Typography>{tr(`${job.review_count} awaiting review`, `${job.review_count} 道待复核`)}</Typography> : null}
      {job.error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Title>{importStatusText(job.error, language)}</Alert.Title></Alert.Content>
        </Alert>
      ) : null}
      <Button
        onPress={() => router.push(`/imports/${job.id}`)}
        accessibilityLabel={tr(`View import details for ${job.file_name}`, `查看${job.file_name}导入详情`)}
      >
        {tr('Details', '详情')}
      </Button>
    </Card>
  );
});

export default function ImportsPage() {
  const db = useSQLiteContext();
  const { tr } = useLanguage();
  const { bankId: rawBankId } = useLocalSearchParams<{ bankId?: string }>();
  const requestedBankId = Number(rawBankId);
  const [pickingBankId, setPickingBankId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [bankPage, setBankPage] = useState(0);
  const [jobPage, setJobPage] = useState(0);

  const selectedBankQuery = useFocusedLiveQuery<BankChoice>(
    `SELECT qb.id, qb.name, s.name AS subject_name
     FROM question_banks qb JOIN subjects s ON s.id = qb.subject_id
     WHERE qb.id = ?`,
    [Number.isInteger(requestedBankId) && requestedBankId > 0 ? requestedBankId : -1],
    ['question_banks', 'subjects'],
  );
  const banksQuery = useFocusedLiveQuery<BankChoice>(
    `SELECT qb.id, qb.name, s.name AS subject_name
     FROM question_banks qb JOIN subjects s ON s.id = qb.subject_id
     ORDER BY qb.updated_at DESC, qb.id DESC LIMIT ? OFFSET ?`,
    [BANK_PAGE_SIZE + 1, bankPage * BANK_PAGE_SIZE],
    ['question_banks', 'subjects'],
  );
  const jobsQuery = useFocusedLiveQuery<ImportListRow>(
    `SELECT j.id, b.name AS bank_name, j.file_name, j.file_type, j.parser, j.status,
       j.ai_profile, j.progress, j.stage, j.error, j.created_at,
       COUNT(o.id) AS output_count,
       SUM(CASE WHEN o.needs_review = 1 THEN 1 ELSE 0 END) AS review_count
     FROM question_import_jobs j
     JOIN question_banks b ON b.id = j.bank_id
     LEFT JOIN outputs o ON o.job_id = j.id
     GROUP BY j.id
     ORDER BY j.created_at DESC, j.id DESC LIMIT ? OFFSET ?`,
    [JOB_PAGE_SIZE + 1, jobPage * JOB_PAGE_SIZE],
    ['question_import_jobs', 'question_banks', 'outputs'],
  );
  const selectedBank = selectedBankQuery.data.find((bank) => bank.id === requestedBankId);
  const pagedBanks = banksQuery.data.slice(0, BANK_PAGE_SIZE);
  const visibleBanks = selectedBank && !pagedBanks.some((bank) => bank.id === selectedBank.id)
    ? [selectedBank, ...pagedBanks]
    : pagedBanks;
  const hasMoreBanks = banksQuery.data.length > BANK_PAGE_SIZE;
  const queryError = selectedBankQuery.error ?? banksQuery.error ?? jobsQuery.error;
  const visibleJobs = useMemo(() => jobsQuery.data.slice(0, JOB_PAGE_SIZE), [jobsQuery.data]);

  const chooseFile = async (bankId: number) => {
    setPickingBankId(bankId);
    setActionError(null);
    try {
      const jobId = await pickAndQueueImport(
        db,
        bankId,
        (details) => confirmAiImport(details, tr),
      );
      if (jobId) router.push(`/imports/${jobId}`);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPickingBankId(null);
    }
  };

  return (
    <FlatList
      data={jobsQuery.error || jobsQuery.loading ? [] : visibleJobs}
      keyExtractor={(job) => String(job.id)}
      renderItem={({ item }) => <ImportJobCard job={item} />}
      ListHeaderComponent={(
        <Surface className="gap-4 rounded-none p-0" variant="transparent">
          <Alert>
            <Alert.Indicator />
            <Alert.Content><Alert.Description>{tr(
              `Documents are parsed with cloud AI. Every send requires confirmation. Maximum file size: ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
              `文档使用云端 AI 解析。每次发送前都需要确认。单个文件最大 ${MAX_IMPORT_BYTES / 1024 / 1024} MB。`,
            )}</Alert.Description></Alert.Content>
          </Alert>
          {actionError ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{actionError}</Alert.Title></Alert.Content>
            </Alert>
          ) : null}
          {queryError ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{queryError.message}</Alert.Title></Alert.Content>
            </Alert>
          ) : null}

          <Surface className="gap-3 rounded-none p-0" variant="transparent">
            <Typography.Heading type="h2">{tr('1. Choose a destination bank', '1. 选择目标题库')}</Typography.Heading>
            {banksQuery.loading ? (
              <Surface accessibilityRole="progressbar" accessibilityLabel={tr('Loading banks', '正在加载题库')}>
                <Spinner />
                <Typography>{tr('Loading banks', '正在加载题库')}</Typography>
              </Surface>
            ) : !visibleBanks.length ? (
              <Alert>
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>{tr('No banks available for import', '还没有可导入的题库')}</Alert.Title>
                  <Alert.Description>{tr('Create a bank first, then choose a TXT or DOCX file.', '请先创建题库，再选择 TXT 或 DOCX 文件。')}</Alert.Description>
                </Alert.Content>
                <Button onPress={() => router.push('/banks/new')}>{tr('Create bank', '创建题库')}</Button>
              </Alert>
            ) : (
              visibleBanks.map((bank) => (
                <Card className="gap-3" key={bank.id}>
                  <Chip>{bank.subject_name}</Chip>
                  {selectedBank?.id === bank.id ? <Chip>{tr('Current bank', '当前题库')}</Chip> : null}
                  <Typography.Heading type="h3">{bank.name}</Typography.Heading>
                  <Button
                    isDisabled={pickingBankId !== null}
                    onPress={() => void chooseFile(bank.id)}
                    accessibilityLabel={tr(`Choose a TXT or DOCX file for ${bank.name} and send it to cloud AI after confirmation`, `为${bank.name}选择 TXT 或 DOCX 文件并在确认后发送到云端 AI 解析`)}
                  >
                    {pickingBankId === bank.id ? tr('Choosing…', '正在选择…') : tr('Choose file · Cloud AI', '选择文件 · 云端 AI')}
                  </Button>
                </Card>
              ))
            )}
            {bankPage > 0 || hasMoreBanks ? (
              <Pager
                page={bankPage}
                hasNext={hasMoreBanks}
                label={tr(`Bank page ${bankPage + 1}`, `题库第 ${bankPage + 1} 页`)}
                onPageChange={setBankPage}
              />
            ) : null}
          </Surface>

          <Typography.Heading type="h2">{tr('Recent import jobs', '最近导入任务')}</Typography.Heading>
          {jobsQuery.loading ? (
            <Surface accessibilityRole="progressbar" accessibilityLabel={tr('Loading import jobs', '正在加载导入任务')}>
              <Spinner />
              <Typography>{tr('Loading import jobs', '正在加载导入任务')}</Typography>
            </Surface>
          ) : !jobsQuery.data.length ? (
            <Alert>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{tr('No import jobs yet', '还没有导入任务')}</Alert.Title>
                <Alert.Description>{tr('Choose a bank and file above to begin.', '选择上方题库和文件即可开始。')}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
        </Surface>
      )}
      ListFooterComponent={jobPage > 0 || jobsQuery.data.length > JOB_PAGE_SIZE ? (
            <Pager
              page={jobPage}
              hasNext={jobsQuery.data.length > JOB_PAGE_SIZE}
              label={tr(`Page ${jobPage + 1}`, `第 ${jobPage + 1} 页`)}
              onPageChange={setJobPage}
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
