import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Alert as NativeAlert, FlatList, StyleSheet } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Checkbox } from 'heroui-native/checkbox';
import { Chip } from 'heroui-native/chip';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { RadioGroup } from 'heroui-native/radio-group';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { TextArea } from 'heroui-native/text-area';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';
import { useThemeColor } from 'heroui-native/hooks';
import { Check } from 'lucide-react-native';

import { ContentBlocks, MediaAttachments } from '@/components/question-content';
import { ScreenState } from '@/components/screen-state';
import { useFocusedLiveQuery, writeTransaction } from '@/database';
import { finishPracticeSession, submitPracticeAnswer } from './actions';
import {
  draftFor,
  formatAnswer,
  formatScore,
  mediaOutsideBlocks,
  readAnswer,
  readBlocks,
  readMedia,
  readOptions,
  type DraftAnswer,
  type SessionQuestion,
} from './format';
import { questionTypeLabel } from '@/i18n';
import { useLanguage } from '@/language';
import { LIST_CONTENT_STYLE } from '@/layout';
import { MAX_BLANK_COUNT, MAX_BLANK_VALUE_LENGTH, MAX_QUESTION_TEXT_LENGTH } from '@/logic';
import { PRACTICE_SESSION_QUESTIONS_SQL } from '@/practice-snapshot';
import type { PracticeSession } from '@/types';

function nextUnansweredIndex(questions: SessionQuestion[], currentIndex: number, excludedId?: number) {
  for (let offset = 1; offset <= questions.length; offset += 1) {
    const index = (currentIndex + offset) % questions.length;
    const question = questions[index];
    if (question.id !== excludedId && question.submitted_answer_json === null) return index;
  }
  return -1;
}

const PracticeResultCard = memo(function PracticeResultCard({ question, index }: { question: SessionQuestion; index: number }) {
  const { tr } = useLanguage();
  const options = readOptions(question.options_json);
  const questionBlocks = readBlocks(question.blocks_json);
  const groupBlocks = readBlocks(question.group_blocks_json);
  const questionMedia = mediaOutsideBlocks(readMedia(question.media_json), questionBlocks);
  const groupMedia = mediaOutsideBlocks(readMedia(question.group_media_json), groupBlocks);
  const submitted = question.submitted_answer_json ? readAnswer(question.submitted_answer_json) : null;
  const resultLabel = !submitted
    ? tr('Not answered', '未作答')
    : question.is_correct === 1
      ? tr('Correct', '正确')
      : question.is_correct === 0
        ? tr('Incorrect', '错误')
        : tr('Reference response', '参考作答');

  return (
    <Card>
      <Card.Header>
        <Typography.Heading type="h3">{tr(`Question ${index + 1}`, `第 ${index + 1} 题`)}</Typography.Heading>
        <Chip
          color={question.is_correct === 1 ? 'success' : question.is_correct === 0 ? 'danger' : 'default'}
          variant="soft"
        >
          {resultLabel}
        </Chip>
      </Card.Header>
      <Card.Body>
        {question.group_stem ? (
          <Surface className="gap-3" variant="tertiary">
            <Chip variant="soft">{tr('Question group material', '题组材料')}</Chip>
            <Typography>{question.group_stem}</Typography>
            <ContentBlocks blocks={groupBlocks} />
            <MediaAttachments media={groupMedia} />
          </Surface>
        ) : null}
        <Typography>{question.stem}</Typography>
        <ContentBlocks blocks={questionBlocks} />
        <MediaAttachments media={questionMedia} />
        {options.map((option) => (
          <Surface className="gap-2" variant="tertiary" key={option.id ?? option.label}>
            <Typography color="muted">{`${option.label}. ${option.content}`}</Typography>
            <MediaAttachments media={readMedia(option.media_json)} />
          </Surface>
        ))}
        <Typography.Heading type="h4">{tr('Your answer', '你的答案')}</Typography.Heading>
        <Typography>{submitted ? formatAnswer(question.question_type_code, submitted, options, tr) : tr('Not answered', '未作答')}</Typography>
        <Typography.Heading type="h4">{tr('Reference answer', '参考答案')}</Typography.Heading>
        <Typography>{formatAnswer(question.question_type_code, readAnswer(question.answer_json), options, tr)}</Typography>
        <Typography.Heading type="h4">{tr('Explanation', '解析')}</Typography.Heading>
        <Typography>{question.explanation || tr('No explanation available', '暂无解析')}</Typography>
      </Card.Body>
      <Card.Footer>
        <Typography color="muted">
          {tr('Score: ', '得分：')}{question.earned_score === null ? '—' : formatScore(question.earned_score)} / {formatScore(question.max_score)}
        </Typography>
      </Card.Footer>
    </Card>
  );
});

const PracticeNavigation = memo(function PracticeNavigation({
  questions,
  currentIndex,
  onSelect,
}: {
  questions: SessionQuestion[];
  currentIndex: number;
  onSelect: (index: number) => void;
}) {
  const { tr } = useLanguage();
  const [accentForegroundColor, accentSoftForegroundColor] = useThemeColor([
    'accent-foreground',
    'accent-soft-foreground',
  ]);
  return (
    <FlatList
      horizontal
      data={questions}
      keyExtractor={(question) => String(question.id)}
      renderItem={({ item: question, index }) => {
        const isCurrent = index === currentIndex;
        const isAnswered = question.submitted_answer_json !== null;
        return (
          <Button
            className="min-w-16"
            variant={isCurrent ? 'primary' : isAnswered ? 'secondary' : 'ghost'}
            accessibilityLabel={tr(
              `Question ${index + 1}, ${isAnswered ? 'answered' : 'unanswered'}${isCurrent ? ', current question' : ''}`,
              `第 ${index + 1} 题，${isAnswered ? '已答' : '未答'}${isCurrent ? '，当前题' : ''}`,
            )}
            accessibilityState={{ selected: isCurrent }}
            onPress={() => onSelect(index)}
          >
            <Button.Label>{index + 1}</Button.Label>
            {isAnswered ? (
              <Check
                accessible={false}
                color={isCurrent ? accentForegroundColor : accentSoftForegroundColor}
                size={16}
              />
            ) : null}
          </Button>
        );
      }}
      contentContainerStyle={styles.navigation}
      showsHorizontalScrollIndicator={false}
      initialNumToRender={20}
      maxToRenderPerBatch={20}
      windowSize={5}
    />
  );
});

function PracticeResults({ session, questions }: { session: PracticeSession; questions: SessionQuestion[] }) {
  const { tr } = useLanguage();
  const modeName = {
    all: tr('All questions', '全部练习'),
    wrong: tr('Retry incorrect answers', '错题重练'),
    type: tr('By question type', '按题型'),
    exam: tr('Exam mode', '考试模式'),
  }[session.mode];
  const subjectiveCount = session.answered_count - session.correct_count - session.incorrect_count;

  return (
    <FlatList
      data={questions}
      keyExtractor={(question) => String(question.id)}
      renderItem={({ item, index }) => <PracticeResultCard question={item} index={index} />}
      ListHeaderComponent={(
        <Surface className="gap-4 rounded-none p-0" variant="transparent">
          <Stack.Screen options={{ title: tr('Practice results', '练习结果') }} />
          <Typography.Heading type="h2">
            {session.status === 'completed' ? tr('Practice results', '练习结果') : tr('Abandoned practice', '已放弃的练习')}
          </Typography.Heading>
          <Typography color="muted">{`${session.bank_name} · ${modeName}`}</Typography>
          <Button variant="secondary" onPress={() => router.replace(`/banks/${session.bank_id}`)}>{tr('Back to question bank', '返回题库')}</Button>
          <Surface variant="secondary">
            <Typography>{tr(`Answered ${session.answered_count}/${session.total_questions}`, `已答 ${session.answered_count}/${session.total_questions}`)}</Typography>
            <Typography>{tr(`Correct ${session.correct_count}`, `正确 ${session.correct_count}`)}</Typography>
            <Typography>{tr(`Incorrect ${session.incorrect_count}`, `错误 ${session.incorrect_count}`)}</Typography>
            <Typography>{tr(`Objective score ${formatScore(session.score)}/${formatScore(session.max_score)}`, `客观题得分 ${formatScore(session.score)}/${formatScore(session.max_score)}`)}</Typography>
            {subjectiveCount ? <Typography color="muted">{tr(`${subjectiveCount} subjective questions: compare with the reference answer`, `${subjectiveCount} 道主观题：请对照参考答案`)}</Typography> : null}
          </Surface>
          <Typography.Heading type="h2">{tr('Results by question', '逐题结果')}</Typography.Heading>
        </Surface>
      )}
      contentContainerStyle={LIST_CONTENT_STYLE}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      initialNumToRender={3}
      maxToRenderPerBatch={4}
      windowSize={5}
    />
  );
}

export default function PracticeSessionPage() {
  const db = useSQLiteContext();
  const { language, tr } = useLanguage();
  const { sessionId: rawSessionId } = useLocalSearchParams<{ sessionId: string }>();
  const parsedSessionId = Number(rawSessionId);
  const sessionId = Number.isInteger(parsedSessionId) && parsedSessionId > 0 ? parsedSessionId : -1;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, DraftAnswer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState('');
  const hydratedSession = useRef<number | null>(null);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPosition = useRef<number | null>(null);

  const sessionQuery = useFocusedLiveQuery<PracticeSession>(
    `SELECT ps.id, ps.bank_id, qb.name AS bank_name, ps.mode, ps.status, ps.exam_mode,
       ps.total_questions, ps.answered_count, ps.correct_count, ps.incorrect_count,
       ps.score, ps.max_score, ps.current_index, ps.started_at, ps.completed_at
     FROM practice_sessions ps
     JOIN question_banks qb ON qb.id = ps.bank_id
     WHERE ps.id = ?`,
    [sessionId],
    ['practice_sessions', 'question_banks'],
  );
  const questionsQuery = useFocusedLiveQuery<SessionQuestion>(
    PRACTICE_SESSION_QUESTIONS_SQL,
    [sessionId],
    ['practice_session_questions', 'question_answers'],
  );
  const session = sessionQuery.data[0];
  const questions = questionsQuery.data;
  const current = questions.length ? questions[Math.min(currentIndex, questions.length - 1)] : null;
  const currentContent = useMemo(() => {
    if (!current) return null;
    const questionBlocks = readBlocks(current.blocks_json);
    const groupBlocks = readBlocks(current.group_blocks_json);
    return {
      options: readOptions(current.options_json),
      questionBlocks,
      groupBlocks,
      questionMedia: mediaOutsideBlocks(readMedia(current.media_json), questionBlocks),
      groupMedia: mediaOutsideBlocks(readMedia(current.group_media_json), groupBlocks),
      answerKey: readAnswer(current.answer_json),
    };
  }, [current]);
  const updateDraft = useCallback((change: (value: DraftAnswer) => DraftAnswer) => {
    if (!current) return;
    setDrafts((values) => ({
      ...values,
      [current.id]: change(values[current.id] ?? draftFor(current)),
    }));
  }, [current]);
  const goTo = useCallback((index: number) => {
    if (!session || index < 0 || index >= questions.length) return;
    setCurrentIndex(index);
    setError('');
    pendingPosition.current = index;
    if (positionTimer.current) clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(() => {
      const position = pendingPosition.current;
      pendingPosition.current = null;
      if (position === null) return;
      void writeTransaction(db, [], (transaction) => transaction.runAsync(
        `UPDATE practice_sessions SET current_index = ? WHERE id = ? AND status = 'active'`,
        position,
        session.id,
      )).catch((reason: unknown) => setError(
        reason instanceof Error ? reason.message : tr('Failed to save the current position', '无法保存当前位置'),
      ));
    }, 800);
  }, [db, questions.length, session, tr]);
  const modeNames = {
    all: tr('All questions', '全部练习'),
    wrong: tr('Retry incorrect answers', '错题重练'),
    type: tr('By question type', '按题型'),
    exam: tr('Exam mode', '考试模式'),
  } as const;

  useEffect(() => {
    if (!session || !questions.length || hydratedSession.current === session.id) return;
    hydratedSession.current = session.id;
    if (session.status !== 'active') {
      setCurrentIndex(0);
      return;
    }
    const preferred = Math.min(Math.max(session.current_index, 0), questions.length - 1);
    const next = questions.findIndex((question, index) => (
      index >= preferred && question.submitted_answer_json === null
    ));
    const earlier = questions.findIndex((question) => question.submitted_answer_json === null);
    setCurrentIndex(next >= 0 ? next : earlier >= 0 ? earlier : preferred);
  }, [questions, session]);

  // Flush pending position write on unmount or session change.
  useEffect(() => () => {
    if (positionTimer.current) clearTimeout(positionTimer.current);
    const position = pendingPosition.current;
    pendingPosition.current = null;
    if (position !== null && session && session.status === 'active') {
      void writeTransaction(db, [], (transaction) => transaction.runAsync(
        `UPDATE practice_sessions SET current_index = ? WHERE id = ? AND status = 'active'`,
        position,
        session.id,
      )).catch(() => undefined);
    }
  }, [db, session]);

  if (sessionQuery.loading && !sessionQuery.data.length) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Practice', '练习') }} />
        <Spinner accessibilityRole="progressbar" accessibilityLabel={tr('Restoring practice session', '正在恢复练习会话')} />
        <Typography color="muted">{tr('Restoring practice session', '正在恢复练习会话')}</Typography>
      </ScreenState>
    );
  }

  if (sessionQuery.error) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Practice', '练习') }} />
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{tr('Failed to load the practice session. Go back and try again.', '读取练习会话失败，请返回后重试。')}</Alert.Title>
          </Alert.Content>
        </Alert>
      </ScreenState>
    );
  }

  if (!session) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Practice', '练习') }} />
        <Typography.Heading type="h2">{tr('Practice session not found', '练习会话不存在')}</Typography.Heading>
        <Typography color="muted">{tr('The link may have expired, or the associated question bank may have been deleted.', '链接可能已失效，或关联题库已被删除。')}</Typography>
        <Button onPress={() => router.replace('/banks')}>{tr('Back to question banks', '返回题库')}</Button>
      </ScreenState>
    );
  }

  if (questionsQuery.loading && !questionsQuery.data.length) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: session.bank_name }} />
        <Spinner accessibilityRole="progressbar" accessibilityLabel={tr('Loading questions', '正在读取试题')} />
        <Typography color="muted">{tr('Loading questions', '正在读取试题')}</Typography>
      </ScreenState>
    );
  }

  if (questionsQuery.error) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: session.bank_name }} />
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{tr('Failed to load the session questions. Go back and try again.', '读取会话试题失败，请返回后重试。')}</Alert.Title>
          </Alert.Content>
        </Alert>
      </ScreenState>
    );
  }

  if (!questions.length) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: session.bank_name }} />
        <Typography.Heading type="h2">{tr('No questions in this session', '会话没有试题')}</Typography.Heading>
        <Typography color="muted">{tr('Local data may be corrupted. Return to the question bank and create a new practice session.', '本地数据可能已损坏，请返回题库重新创建练习。')}</Typography>
        <Button onPress={() => router.replace(`/banks/${session.bank_id}`)}>{tr('Back to question bank', '返回题库')}</Button>
      </ScreenState>
    );
  }

  if (session.status !== 'active') {
    return <PracticeResults session={session} questions={questions} />;
  }

  if (!current || !currentContent) return null;
  const { options, questionBlocks, groupBlocks, questionMedia, groupMedia, answerKey } = currentContent;
  const draft = drafts[current.id] ?? draftFor(current);
  const answered = current.submitted_answer_json !== null;
  const storedBlankCount = Array.isArray(answerKey.blanks) ? answerKey.blanks.length : 0;
  const expectedBlankCount = Math.min(MAX_BLANK_COUNT, Math.max(1, storedBlankCount));
  const answerKeyTooLarge = storedBlankCount > MAX_BLANK_COUNT;
  const ready = !answerKeyTooLarge && current.question_type_code === 'fill_blank'
    ? draft.blanks.length === expectedBlankCount && draft.blanks.every((blank) => blank.trim())
    : current.question_type_code === 'short_answer'
      ? Boolean(draft.text.trim())
      : Boolean(draft.values.length);

  const submit = async () => {
    if (finishing || answered || !ready) return;
    const submitted = current.question_type_code === 'fill_blank'
      ? { blanks: draft.blanks.map((blank) => blank.trim()) }
      : current.question_type_code === 'short_answer'
        ? { text: draft.text.trim() }
        : { values: draft.values };
    setSubmitting(true);
    setError('');
    try {
      const grade = await submitPracticeAnswer(db, session.id, current.id, submitted);
      const announcement = session.exam_mode
        ? tr(`Answer for question ${currentIndex + 1} submitted`, `第 ${currentIndex + 1} 题答案已提交`)
        : grade.isCorrect === null
          ? tr('Answer submitted. Compare it with the reference answer.', '答案已提交，请对照参考答案')
          : grade.isCorrect
            ? tr('Correct answer', '回答正确')
            : tr('Incorrect answer', '回答错误');
      AccessibilityInfo.announceForAccessibility(announcement);
      if (session.exam_mode) {
        const next = nextUnansweredIndex(questions, currentIndex, current.id);
        if (next >= 0) goTo(next);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Failed to submit the answer', '答案提交失败'));
    } finally {
      setSubmitting(false);
    }
  };
  const closeSession = async (status: 'completed' | 'abandoned') => {
    if (submitting) return;
    setFinishing(true);
    setError('');
    try {
      await finishPracticeSession(db, session.id, status);
      AccessibilityInfo.announceForAccessibility(status === 'completed' ? tr('Practice completed', '练习已完成') : tr('Practice abandoned', '练习已放弃'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Failed to end the practice session', '无法结束练习'));
    } finally {
      setFinishing(false);
    }
  };
  const confirmComplete = () => {
    const remaining = session.total_questions - session.answered_count;
    NativeAlert.alert(
      session.exam_mode ? tr('Finish exam?', '完成考试？') : tr('Finish practice?', '完成练习？'),
      remaining
        ? tr(`${remaining} questions remain unanswered. You cannot continue answering after finishing.`, `还有 ${remaining} 题未作答，完成后不能继续。`)
        : tr('Results for each question will be shown after finishing.', '完成后将显示逐题结果。'),
      [
        { text: tr('Continue answering', '继续答题'), style: 'cancel' },
        { text: tr('Finish', '完成'), onPress: () => void closeSession('completed') },
      ],
    );
  };
  const confirmAbandon = () => NativeAlert.alert(
    tr('Abandon this practice session?', '放弃本次练习？'),
    tr('Submitted answers will be kept, but you will not be able to continue this session.', '已提交的答案会保留，但会话将不能继续。'),
    [
      { text: tr('Cancel', '取消'), style: 'cancel' },
      { text: tr('Abandon', '放弃'), style: 'destructive', onPress: () => void closeSession('abandoned') },
    ],
  );
  const showFeedback = answered && !session.exam_mode;
  const next = nextUnansweredIndex(questions, currentIndex);

  return (
    <ScreenState>
        <Stack.Screen options={{ title: session.exam_mode ? tr('Exam', '考试') : session.bank_name }} />
        <Typography color="muted">{`${modeNames[session.mode]} · ${tr(`Question ${currentIndex + 1}/${session.total_questions}`, `第 ${currentIndex + 1}/${session.total_questions} 题`)}`}</Typography>
        <Button variant="danger" isDisabled={finishing || submitting} onPress={confirmAbandon}>{tr('Abandon', '放弃')}</Button>

        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}

        <Surface
          variant="secondary"
          accessibilityRole="progressbar"
          accessibilityLabel={tr('Answering progress', '答题进度')}
          accessibilityValue={{
            min: 0,
            max: session.total_questions,
            now: session.answered_count,
            text: tr(`${session.answered_count} of ${session.total_questions} questions answered`, `已答 ${session.answered_count} 题，共 ${session.total_questions} 题`),
          }}
        >
          <Typography.Heading type="h2">{tr('Progress', '进度')}</Typography.Heading>
          <Typography>{tr(`Answered ${session.answered_count}/${session.total_questions}`, `已答 ${session.answered_count}/${session.total_questions}`)}</Typography>
          <Typography color="muted">
            {!session.exam_mode
              ? tr(`Correct ${session.correct_count} · Objective score ${formatScore(session.score)}`, `正确 ${session.correct_count} · 客观题得分 ${formatScore(session.score)}`)
              : tr('Results will be shown after submission', '结果将在交卷后显示')}
          </Typography>
        </Surface>

        <Surface variant="secondary">
          <Typography.Heading type="h2">{tr('Question navigation', '答题导航')}</Typography.Heading>
          <Typography color="muted">{tr('Submitted questions are marked. Select a question number to jump to it.', '已提交的题目会标记；选择题号可直接跳转。')}</Typography>
          <PracticeNavigation questions={questions} currentIndex={currentIndex} onSelect={goTo} />
        </Surface>

        {current.group_stem ? (
          <Card>
            <Card.Header>
              <Chip variant="soft">{tr('Question group material', '题组材料')}</Chip>
            </Card.Header>
            <Card.Body>
              <Typography>{current.group_stem}</Typography>
              <ContentBlocks blocks={groupBlocks} />
              <MediaAttachments media={groupMedia} />
            </Card.Body>
          </Card>
        ) : null}

        <Card className="gap-3">
          <Card.Header>
            <Chip variant="soft">{questionTypeLabel(current.question_type_code, language)}</Chip>
            <Chip variant="soft">{tr(`${formatScore(current.max_score)} points`, `${formatScore(current.max_score)} 分`)}</Chip>
            <Chip color={answered ? 'success' : 'warning'} variant="soft">{answered ? tr('Submitted', '已提交') : tr('Not submitted', '未提交')}</Chip>
            <Typography color="muted">{tr(`Question ${currentIndex + 1}`, `第 ${currentIndex + 1} 题`)}</Typography>
          </Card.Header>
          <Card.Body>
            <Typography.Heading type="h2">{current.stem}</Typography.Heading>
            <ContentBlocks blocks={questionBlocks} />
            <MediaAttachments media={questionMedia} />

            {current.question_type_code === 'single_choice' ? (
              !options.length ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content><Alert.Title>{tr('This question has no options. Return to the question bank and check the question.', '此题没有可选项，请返回题库检查题目。')}</Alert.Title></Alert.Content>
                </Alert>
              ) : (
                <RadioGroup
                  value={draft.values[0]}
                  onValueChange={(value) => updateDraft((answer) => ({ ...answer, values: [value] }))}
                  isDisabled={answered}
                  accessibilityLabel={tr('Answer options', '答案选项')}
                >
                  {options.map((option) => (
                    <Surface className="gap-2" variant="tertiary" key={option.id ?? option.label}>
                      <RadioGroup.Item value={option.label}>{`${option.label}. ${option.content}`}</RadioGroup.Item>
                      <MediaAttachments media={readMedia(option.media_json)} />
                    </Surface>
                  ))}
                </RadioGroup>
              )
            ) : null}

            {current.question_type_code === 'multiple_choice' ? (
              !options.length ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content><Alert.Title>{tr('This question has no options. Return to the question bank and check the question.', '此题没有可选项，请返回题库检查题目。')}</Alert.Title></Alert.Content>
                </Alert>
              ) : options.map((option) => (
                <Surface key={option.id ?? option.label} variant="tertiary">
                  <Checkbox
                    accessibilityLabel={tr(`${option.label}, ${option.content}`, `${option.label}，${option.content}`)}
                    isSelected={draft.values.includes(option.label)}
                    isDisabled={answered}
                    onSelectedChange={(isSelected) => updateDraft((answer) => ({
                      ...answer,
                      values: isSelected
                        ? answer.values.includes(option.label) ? answer.values : [...answer.values, option.label]
                        : answer.values.filter((value) => value !== option.label),
                    }))}
                  />
                  <Typography>{`${option.label}. ${option.content}`}</Typography>
                  <MediaAttachments media={readMedia(option.media_json)} />
                </Surface>
              ))
            ) : null}

            {current.question_type_code === 'true_false' ? (
              <RadioGroup
                value={draft.values[0]}
                onValueChange={(value) => updateDraft((answer) => ({ ...answer, values: [value] }))}
                isDisabled={answered}
                accessibilityLabel={tr('True or false', '判断题选项')}
              >
                <RadioGroup.Item value="true">{tr('True', '正确')}</RadioGroup.Item>
                <RadioGroup.Item value="false">{tr('False', '错误')}</RadioGroup.Item>
              </RadioGroup>
            ) : null}

            {current.question_type_code === 'fill_blank' ? (
              <>
                {Array.from({ length: expectedBlankCount }, (_, index) => (
                  <TextField key={index} isDisabled={answered} isRequired>
                    <Label>{tr(`Blank ${index + 1}`, `第 ${index + 1} 空`)}</Label>
                    <Input
                      accessibilityLabel={tr(`Blank ${index + 1}`, `第 ${index + 1} 空`)}
                      value={draft.blanks[index] ?? ''}
                      onChangeText={(text) => updateDraft((answer) => ({
                        ...answer,
                        blanks: Array.from({ length: expectedBlankCount }, (__, blankIndex) => (
                          blankIndex === index ? text : answer.blanks[blankIndex] ?? ''
                        )),
                      }))}
                      returnKeyType={index === expectedBlankCount - 1 ? 'done' : 'next'}
                      maxLength={MAX_BLANK_VALUE_LENGTH}
                    />
                  </TextField>
                ))}
                {answerKeyTooLarge ? (
                  <Alert status="danger">
                    <Alert.Indicator />
                    <Alert.Content><Alert.Title>{tr('This question exceeds the supported number of blanks. Return to the question bank and correct the answer.', '此题填空数量超过支持上限，请返回题库修正答案。')}</Alert.Title></Alert.Content>
                  </Alert>
                ) : null}
              </>
            ) : null}

            {current.question_type_code === 'short_answer' ? (
              <TextField isDisabled={answered} isRequired>
                <Label>{tr('Your answer', '你的回答')}</Label>
                <TextArea
                  accessibilityLabel={tr('Your answer', '你的回答')}
                  value={draft.text}
                  onChangeText={(text) => updateDraft((answer) => ({ ...answer, text }))}
                  maxLength={MAX_QUESTION_TEXT_LENGTH}
                  placeholder={tr('Enter and submit your answer, then compare it with the reference answer.', '输入回答后提交，再对照参考答案。')}
                />
              </TextField>
            ) : null}

            {showFeedback ? (
              <Alert status={current.is_correct === 1 ? 'success' : current.is_correct === 0 ? 'danger' : 'warning'}>
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>
                    {current.is_correct === 1 ? tr('Correct answer', '回答正确') : current.is_correct === 0 ? tr('Incorrect answer', '回答错误') : tr('Compare with the reference answer', '请对照参考答案')}
                  </Alert.Title>
                  <Alert.Description>
                    {current.earned_score === null
                      ? tr('This is a subjective question and is not scored automatically', '本题为主观题，不自动计分')
                      : tr(`Score: ${formatScore(current.earned_score)} / ${formatScore(current.max_score)}`, `本题得分：${formatScore(current.earned_score)} / ${formatScore(current.max_score)}`)}
                  </Alert.Description>
                  <Alert.Description>{tr('Reference answer: ', '参考答案：')}{formatAnswer(current.question_type_code, answerKey, options, tr)}</Alert.Description>
                  <Alert.Description>{tr('Explanation: ', '解析：')}{current.explanation || tr('No explanation available', '暂无解析')}</Alert.Description>
                </Alert.Content>
                {next >= 0 ? <Button variant="secondary" onPress={() => goTo(next)}>{tr('Next unanswered question', '下一道未答题')}</Button> : null}
              </Alert>
            ) : null}
          </Card.Body>
          <Card.Footer className="gap-3">
            <Button variant="ghost" isDisabled={currentIndex === 0} onPress={() => goTo(currentIndex - 1)}>{tr('Previous', '上一题')}</Button>
            <Button
              isDisabled={submitting || finishing || answered || !ready || ((current.question_type_code === 'single_choice' || current.question_type_code === 'multiple_choice') && !options.length)}
              onPress={() => void submit()}
            >
              {submitting ? tr('Submitting…', '正在提交…') : answered ? tr('Submitted', '已提交') : tr('Submit answer', '提交答案')}
            </Button>
            <Button variant="ghost" isDisabled={currentIndex === questions.length - 1} onPress={() => goTo(currentIndex + 1)}>{tr('Next', '下一题')}</Button>
          </Card.Footer>
        </Card>

        <Surface variant="secondary">
          <Typography color="muted">{tr('Submitted answers are saved when you leave. You can continue later from the question bank.', '离开页面不会丢失已提交答案，可稍后从题库继续。')}</Typography>
          <Button isDisabled={finishing || submitting} onPress={confirmComplete}>
            {finishing ? tr('Finishing…', '正在完成…') : session.exam_mode ? tr('Submit exam and view results', '交卷并查看结果') : tr('Finish and view results', '完成并查看结果')}
          </Button>
        </Surface>
    </ScreenState>
  );
}

const styles = StyleSheet.create({
  navigation: {
    gap: 8,
  },
});
