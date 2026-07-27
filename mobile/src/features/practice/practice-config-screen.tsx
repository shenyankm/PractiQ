import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Description } from 'heroui-native/description';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { RadioGroup } from 'heroui-native/radio-group';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';

import { ScreenState } from '@/components/screen-state';
import { useFocusedLiveQuery } from '@/database';
import { createPracticeSession } from './actions';
import { formatDate, questionTypeLabel } from '@/i18n';
import { useLanguage } from '@/language';
import type { PracticeMode, QuestionType } from '@/types';

interface PracticeBank {
  id: number;
  name: string;
  subject_name: string;
  active_count: number;
  wrong_count: number;
}

interface TypeCount {
  code: QuestionType;
  name: string;
  count: number;
}

interface ActiveSession {
  id: number;
  mode: PracticeMode;
  total_questions: number;
  answered_count: number;
  started_at: string;
}

export default function PracticeConfigPage() {
  const db = useSQLiteContext();
  const { language, tr } = useLanguage();
  const { bankId: rawBankId } = useLocalSearchParams<{ bankId: string }>();
  const parsedBankId = Number(rawBankId);
  const bankId = Number.isInteger(parsedBankId) && parsedBankId > 0 ? parsedBankId : -1;
  const [mode, setMode] = useState<PracticeMode>('all');
  const [questionType, setQuestionType] = useState<QuestionType | null>(null);
  const [count, setCount] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const modes: { value: PracticeMode; label: string }[] = [
    { value: 'all', label: tr('All questions', '全部练习') },
    { value: 'wrong', label: tr('Retry incorrect', '错题重练') },
    { value: 'type', label: tr('By question type', '按题型') },
    { value: 'exam', label: tr('Exam mode', '考试模式') },
  ];
  const modeNames: Record<PracticeMode, string> = {
    all: tr('all questions', '全部练习'),
    wrong: tr('retry incorrect', '错题重练'),
    type: tr('by question type', '按题型'),
    exam: tr('exam mode', '考试模式'),
  };

  const bankQuery = useFocusedLiveQuery<PracticeBank>(
    `SELECT qb.id, qb.name, s.name AS subject_name,
       COUNT(DISTINCT CASE WHEN q.status = 'active' AND ak.id IS NOT NULL THEN q.id END) AS active_count,
       COUNT(DISTINCT CASE WHEN q.status = 'active' AND ak.id IS NOT NULL AND qs.incorrect_count > 0 THEN q.id END) AS wrong_count
     FROM question_banks qb
     JOIN subjects s ON s.id = qb.subject_id
     LEFT JOIN bank_question_links bql ON bql.bank_id = qb.id
     LEFT JOIN questions q ON q.id = bql.question_id
     LEFT JOIN question_answer_keys ak ON ak.question_id = q.id AND ak.is_primary = 1
     LEFT JOIN question_stats qs ON qs.question_id = q.id
     WHERE qb.id = ?
     GROUP BY qb.id`,
    [bankId],
    ['question_banks', 'subjects', 'bank_question_links', 'questions', 'question_answer_keys', 'question_answers'],
  );
  const typeQuery = useFocusedLiveQuery<TypeCount>(
    `SELECT qt.code, qt.name, COUNT(DISTINCT q.id) AS count
     FROM question_types qt
     JOIN questions q ON q.question_type_code = qt.code AND q.status = 'active'
     JOIN bank_question_links bql ON bql.question_id = q.id AND bql.bank_id = ?
     JOIN question_answer_keys ak ON ak.question_id = q.id AND ak.is_primary = 1
     GROUP BY qt.code, qt.name, qt.sort_order
     ORDER BY qt.sort_order`,
    [bankId],
    ['question_types', 'questions', 'bank_question_links', 'question_answer_keys'],
  );
  const sessionsQuery = useFocusedLiveQuery<ActiveSession>(
    `SELECT id, mode, total_questions, answered_count, started_at
     FROM practice_sessions
     WHERE bank_id = ? AND status = 'active'
     ORDER BY started_at DESC
     LIMIT 5`,
    [bankId],
    ['practice_sessions'],
  );

  if (bankQuery.loading) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Practice setup', '练习配置') }} />
        <Spinner accessibilityRole="progressbar" accessibilityLabel={tr('Loading bank', '正在读取题库')} />
        <Typography color="muted">{tr('Loading bank', '正在读取题库')}</Typography>
      </ScreenState>
    );
  }

  const bank = bankQuery.data[0];
  if (!bank) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Practice setup', '练习配置') }} />
        <Card className="gap-3">
          <Card.Title>{tr('Bank not found', '题库不存在')}</Card.Title>
          <Typography color="muted">{tr('The link may be invalid, or the bank may have been deleted.', '链接可能已失效，或题库已被删除。')}</Typography>
          <Button onPress={() => router.replace('/banks')}>{tr('Back to banks', '返回题库')}</Button>
        </Card>
      </ScreenState>
    );
  }

  const selectedType = questionType ?? typeQuery.data[0]?.code ?? null;
  const eligible = mode === 'wrong'
    ? bank.wrong_count
    : mode === 'type'
      ? typeQuery.data.find((item) => item.code === selectedType)?.count ?? 0
      : bank.active_count;
  const countValue = count ?? String(Math.min(20, Math.max(1, eligible)));
  const requestedCount = Number(countValue);
  const countIsValid = Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 200;
  const modeDescription = mode === 'all'
    ? tr('Practice all published questions in bank order and see feedback immediately after submitting.', '按题库顺序练习所有已发布试题，提交后立即查看反馈。')
    : mode === 'wrong'
      ? tr('Practice only questions answered incorrectly before and see feedback immediately after submitting.', '只练习曾经答错的题目，提交后立即查看反馈。')
      : mode === 'exam'
        ? tr('Questions are randomized. Answers and explanations appear after the exam is completed.', '题目随机排列，答案和解析将在完成考试后统一显示。')
        : null;

  const start = async () => {
    if (!countIsValid || !eligible || (mode === 'type' && !selectedType)) return;
    setSaving(true);
    setError('');
    try {
      const sessionId = await createPracticeSession(
        db,
        bankId,
        mode,
        mode === 'type' ? selectedType : null,
        requestedCount,
      );
      router.replace(`/practice/${sessionId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Unable to create practice session', '无法创建练习会话'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenState>
        <Stack.Screen options={{ title: tr('Practice setup', '练习配置') }} />
        <Typography color="muted">{`${bank.name} · ${bank.subject_name}`}</Typography>
        {bankQuery.error || typeQuery.error || sessionsQuery.error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{tr('Failed to load practice setup. Please try again later.', '读取练习配置失败，请稍后重试。')}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}
        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}

        {sessionsQuery.data.length ? (
          <Surface className="gap-3 rounded-none p-0" variant="transparent">
            <Typography.Heading type="h2">{tr('Continue unfinished practice', '继续未完成练习')}</Typography.Heading>
            {sessionsQuery.data.map((session) => (
              <Card className="gap-3" key={session.id}>
                <Chip color={session.mode === 'exam' ? 'warning' : 'default'} variant="soft">{modeNames[session.mode]}</Chip>
                <Typography>{tr(`${session.answered_count}/${session.total_questions} answered`, `${session.answered_count}/${session.total_questions} 题已答`)}</Typography>
                <Typography color="muted">{tr(`Started ${formatDate(session.started_at, language)}`, `开始于 ${formatDate(session.started_at, language)}`)}</Typography>
                <Button
                  variant="secondary"
                  accessibilityLabel={tr(`Continue ${modeNames[session.mode]}, ${session.answered_count} answered out of ${session.total_questions}`, `继续${modeNames[session.mode]}，已答 ${session.answered_count} 题，共 ${session.total_questions} 题`)}
                  onPress={() => router.push(`/practice/${session.id}`)}
                >
                  {tr('Continue', '继续')}
                </Button>
              </Card>
            ))}
          </Surface>
        ) : null}

        {!bank.active_count ? (
          <Card className="gap-3">
            <Card.Title>{tr('No questions available for practice', '没有可练习的试题')}</Card.Title>
            <Typography color="muted">{tr('Add complete answers to questions and publish them first.', '请先为题目设置完整答案并发布。')}</Typography>
            <Button onPress={() => router.replace(`/banks/${bankId}/manage`)}>{tr('Manage questions', '管理试题')}</Button>
          </Card>
        ) : (
          <Surface className="gap-4" variant="secondary">
            <Typography.Heading type="h2">{tr('Choose a mode', '选择模式')}</Typography.Heading>
            <RadioGroup value={mode} onValueChange={(value) => setMode(value as PracticeMode)}>
              {modes.map((item) => <RadioGroup.Item key={item.value} value={item.value}>{item.label}</RadioGroup.Item>)}
            </RadioGroup>

            {modeDescription ? (
              <Alert status="accent">
                <Alert.Indicator />
                <Alert.Content><Alert.Description>{modeDescription}</Alert.Description></Alert.Content>
              </Alert>
            ) : null}

            {mode === 'type' ? (
              <Surface variant="tertiary">
                <Typography.Heading type="h3">{tr('Question type', '题型')}</Typography.Heading>
                {typeQuery.data.length && selectedType ? (
                  <RadioGroup value={selectedType} onValueChange={(value) => setQuestionType(value as QuestionType)}>
                    {typeQuery.data.map((item) => (
                      <RadioGroup.Item key={item.code} value={item.code}>{`${questionTypeLabel(item.code, language)} ${item.count}`}</RadioGroup.Item>
                    ))}
                  </RadioGroup>
                ) : (
                  <Alert status="warning">
                    <Alert.Indicator />
                    <Alert.Content><Alert.Description>{tr('This bank has no published question types available for practice.', '此题库没有可练习的已发布题型。')}</Alert.Description></Alert.Content>
                  </Alert>
                )}
              </Surface>
            ) : null}

            <TextField isInvalid={!countIsValid}>
              <Label>{tr('Number of questions', '题目数量')}</Label>
              <Input
                accessibilityLabel={tr('Number of questions', '题目数量')}
                value={countValue}
                onChangeText={(value) => setCount(value.replace(/\D/g, ''))}
                keyboardType="number-pad"
                maxLength={3}
                returnKeyType="done"
              />
              <Description>{tr(`Enter 1–200. This mode has ${eligible} available questions. Question groups are kept together, so the actual count may be slightly higher.`, `可输入 1–200；当前模式有 ${eligible} 题可用。题组不会被拆开，因此实际题数可能略高于所填数量。`)}</Description>
            </TextField>
            {!countIsValid ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content><Alert.Title>{tr('The number of questions must be an integer from 1 to 200.', '题目数量须为 1 到 200 的整数。')}</Alert.Title></Alert.Content>
              </Alert>
            ) : null}
            {!eligible ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content><Alert.Title>{tr('No questions are available for practice in this mode.', '当前模式下没有可练习的题目。')}</Alert.Title></Alert.Content>
              </Alert>
            ) : null}
            <Button
              isDisabled={saving || !countIsValid || !eligible || (mode === 'type' && !selectedType)}
              onPress={() => void start()}
            >
              {saving ? tr('Creating…', '正在创建…') : mode === 'exam' ? tr('Start exam', '开始考试') : tr('Start practice', '开始练习')}
            </Button>
          </Surface>
        )}
    </ScreenState>
  );
}
