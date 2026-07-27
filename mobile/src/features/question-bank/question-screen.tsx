import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert as NativeAlert } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Checkbox } from 'heroui-native/checkbox';
import { Chip } from 'heroui-native/chip';
import { ControlField } from 'heroui-native/control-field';
import { Description } from 'heroui-native/description';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { RadioGroup } from 'heroui-native/radio-group';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { TextArea } from 'heroui-native/text-area';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';

import {
  assertCloudAuthorityCurrent,
  CLOUD_API_URL,
  generateAnswerCloud,
  getCloudAuthorityGeneration,
  hasSession,
} from '@/cloud';
import { MediaAttachmentView } from '@/components/question-content';
import { Pager } from '@/components/pager';
import { ScreenState } from '@/components/screen-state';
import { useFocusedLiveQuery } from '@/database';
import { saveQuestion, setPrimaryAnswerKey } from './actions';
import { importMedia, moveMediaLink, unlinkMedia, updateMediaAnnotation, type MediaTarget } from '@/files/media';
import { formatDate } from '@/i18n';
import { useLanguage } from '@/language';
import { answerToText, makeAnswer, metadataText } from '@/logic';
import type {
  AnswerKey,
  ContentBlock,
  KnowledgePoint,
  MediaAttachment,
  QuestionOption,
  QuestionStatus,
  QuestionType,
} from '@/types';
import { useUnsavedChanges } from '@/use-unsaved-changes';
import { ContentBlockEditor } from './content-block-editor';
const OPTION_LABELS = 'ABCDEFGH';
const SELECTOR_PAGE_SIZE = 30;
const VERSION_PAGE_SIZE = 20;
interface QuestionRow {
  id: number;
  bank_id: number;
  question_type_code: QuestionType;
  stem: string;
  explanation: string;
  status: QuestionStatus;
  difficulty: number;
  default_score: number;
  answer_json: string | null;
}

interface BankRow {
  subject_id: number;
  subject_name: string;
  name: string;
}

interface LinkRow {
  knowledge_point_id: number;
}

interface MediaRow extends MediaAttachment {
  link_id: number;
  metadata_json: string | null;
  target_type: 'question' | 'option' | 'group';
  target_id: number;
  target_label: string;
}

interface GroupRow {
  id: number;
  stem: string;
}

interface GroupLinkRow {
  group_id: number;
}

const blankOptions = (): QuestionOption[] => [
  { label: 'A', content: '', sort_order: 0 },
  { label: 'B', content: '', sort_order: 1 },
];

function readAnswer(type: QuestionType, json: string | null) {
  if (!json) return '';
  try {
    return answerToText(type, JSON.parse(json));
  } catch {
    return json;
  }
}

export default function QuestionPage() {
  const db = useSQLiteContext();
  const { language, tr } = useLanguage();
  const params = useLocalSearchParams<{ questionId: string; bankId?: string; edit?: string }>();
  const isNew = params.questionId === 'new';
  const questionId = isNew ? 0 : Number(params.questionId);
  const requestedBankId = Number(params.bankId) || 0;
  const validQuestionId = isNew || (Number.isInteger(questionId) && questionId > 0);
  const initialized = useRef<number | null>(null);
  const aiController = useRef<AbortController | null>(null);

  const [editing, setEditing] = useState(isNew || params.edit === '1');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [switchingKey, setSwitchingKey] = useState(0);
  const [type, setType] = useState<QuestionType>('single_choice');
  const [status, setStatus] = useState<QuestionStatus>('draft');
  const [originalStatus, setOriginalStatus] = useState<QuestionStatus>('draft');
  const [stem, setStem] = useState('');
  const [explanation, setExplanation] = useState('');
  const [difficulty, setDifficulty] = useState('3');
  const [score, setScore] = useState('1');
  const [answerText, setAnswerText] = useState('');
  const [options, setOptions] = useState<QuestionOption[]>(blankOptions);
  const [knowledgePointIds, setKnowledgePointIds] = useState<number[]>([]);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);
  const [mediaTarget, setMediaTarget] = useState('question');
  const [mediaNotes, setMediaNotes] = useState<Record<number, string>>({});
  const [knowledgePage, setKnowledgePage] = useState(0);
  const [groupPage, setGroupPage] = useState(0);
  const [versionPage, setVersionPage] = useState(0);
  const hasUnsavedChanges = editing && (dirty || Object.keys(mediaNotes).length > 0);
  const { confirmDiscard, runWithoutPrompt } = useUnsavedChanges(hasUnsavedChanges);
  const questionTypes: { value: QuestionType; label: string }[] = [
    { value: 'single_choice', label: tr('Single choice', '单选题') },
    { value: 'multiple_choice', label: tr('Multiple choice', '多选题') },
    { value: 'true_false', label: tr('True or false', '判断题') },
    { value: 'fill_blank', label: tr('Fill in the blank', '填空题') },
    { value: 'short_answer', label: tr('Short answer', '简答题') },
  ];
  const statusLabels: Record<QuestionStatus, string> = {
    draft: tr('Draft', '草稿'),
    active: tr('Published', '已发布'),
    archived: tr('Archived', '已归档'),
  };
  const trueFalseAnswers = [
    { value: answerToText('true_false', { values: ['true'] }), label: tr('True', '正确') },
    { value: answerToText('true_false', { values: ['false'] }), label: tr('False', '错误') },
  ];
  const displayAnswer = (value: string) => type === 'true_false'
    ? trueFalseAnswers.find((item) => item.value === value)?.label ?? value
    : value;

  const questionResult = useFocusedLiveQuery<QuestionRow>(
    `SELECT q.id,
       COALESCE(NULLIF(?, 0), (SELECT bank_id FROM bank_question_links WHERE question_id = q.id ORDER BY bank_id LIMIT 1)) AS bank_id,
       q.question_type_code, q.stem, q.explanation, q.status, q.difficulty,
       q.default_score, ak.answer_json
     FROM questions q
     LEFT JOIN question_answer_keys ak ON ak.question_id = q.id AND ak.is_primary = 1
     WHERE q.id = ?
       AND (? = 0 OR EXISTS (
         SELECT 1 FROM bank_question_links bql WHERE bql.question_id = q.id AND bql.bank_id = ?
       ))`,
    [requestedBankId, questionId || -1, requestedBankId, requestedBankId],
    ['questions', 'question_answer_keys', 'bank_question_links'],
  );
  const question = questionResult.data[0];
  const bankId = isNew ? requestedBankId : (question?.bank_id ?? requestedBankId);
  const bankResult = useFocusedLiveQuery<BankRow>(
    `SELECT qb.subject_id, s.name AS subject_name, qb.name
     FROM question_banks qb JOIN subjects s ON s.id = qb.subject_id WHERE qb.id = ?`,
    [bankId || -1],
    ['question_banks', 'subjects'],
  );
  const bank = bankResult.data[0];
  const knowledgeResult = useFocusedLiveQuery<KnowledgePoint>(
    `SELECT id, name FROM knowledge_points
     WHERE subject_id = ? ORDER BY parent_id, sort_order, name, id LIMIT ? OFFSET ?`,
    [
      bank?.subject_id ?? -1,
      SELECTOR_PAGE_SIZE + 1,
      knowledgePage * SELECTOR_PAGE_SIZE,
    ],
    ['knowledge_points'],
  );
  const selectedKnowledgeResult = useFocusedLiveQuery<KnowledgePoint>(
    `SELECT id, name FROM knowledge_points
     WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
     ORDER BY name, id`,
    [JSON.stringify(knowledgePointIds)],
    ['knowledge_points'],
  );
  const optionsResult = useFocusedLiveQuery<QuestionOption>(
    'SELECT id, label, content, sort_order FROM question_options WHERE question_id = ? ORDER BY sort_order, id',
    [questionId || -1],
    ['question_options'],
  );
  const linksResult = useFocusedLiveQuery<LinkRow>(
    'SELECT knowledge_point_id FROM question_knowledge_links WHERE question_id = ? ORDER BY knowledge_point_id',
    [questionId || -1],
    ['question_knowledge_links'],
  );
  const groupsResult = useFocusedLiveQuery<GroupRow>(
    `SELECT qg.id, qg.stem
     FROM bank_group_links bgl JOIN question_groups qg ON qg.id = bgl.group_id
     WHERE bgl.bank_id = ? ORDER BY bgl.sort_order, qg.id LIMIT ? OFFSET ?`,
    [bankId || -1, SELECTOR_PAGE_SIZE + 1, groupPage * SELECTOR_PAGE_SIZE],
    ['bank_group_links', 'question_groups'],
  );
  const selectedGroupResult = useFocusedLiveQuery<GroupRow>(
    `SELECT qg.id, qg.stem
     FROM question_groups qg
     JOIN bank_group_links bgl ON bgl.group_id = qg.id
     WHERE qg.id = ? AND bgl.bank_id = ?`,
    [groupId ?? -1, bankId || -1],
    ['question_groups', 'bank_group_links'],
  );
  const groupLinkResult = useFocusedLiveQuery<GroupLinkRow>(
    `SELECT gql.group_id FROM group_question_links gql
     JOIN bank_group_links bgl ON bgl.group_id = gql.group_id
     WHERE gql.question_id = ? AND bgl.bank_id = ?
     ORDER BY gql.sort_order, gql.group_id LIMIT 1`,
    [questionId || -1, bankId || -1],
    ['group_question_links', 'bank_group_links'],
  );
  const blocksResult = useFocusedLiveQuery<ContentBlock>(
    `SELECT qcb.id, qcb.kind, qcb.content, qcb.metadata_json, qcb.media_asset_id, qcb.sort_order,
       ma.uri AS media_uri, ma.mime_type AS media_mime_type, ma.file_name AS media_file_name
     FROM question_content_blocks qcb
     LEFT JOIN media_assets ma ON ma.id = qcb.media_asset_id
     WHERE qcb.question_id = ? ORDER BY qcb.sort_order, qcb.id`,
    [questionId || -1],
    ['question_content_blocks', 'media_assets'],
  );
  const versionsResult = useFocusedLiveQuery<AnswerKey>(
    `SELECT id, version, answer_json, is_primary, created_at
     FROM question_answer_keys WHERE question_id = ? ORDER BY version DESC LIMIT ? OFFSET ?`,
    [questionId || -1, VERSION_PAGE_SIZE + 1, versionPage * VERSION_PAGE_SIZE],
    ['question_answer_keys'],
  );
  const mediaResult = useFocusedLiveQuery<MediaRow>(
    `SELECT ma.id, ml.id AS link_id, ma.file_name, ma.mime_type, ma.uri,
       ma.width, ma.height, ma.duration, ma.metadata_json,
        CASE WHEN ml.question_id IS NOT NULL THEN 'question'
            WHEN ml.option_id IS NOT NULL THEN 'option' ELSE 'group' END AS target_type,
       COALESCE(ml.question_id, ml.option_id, ml.group_id) AS target_id,
        CASE WHEN ml.question_id IS NOT NULL THEN ''
             WHEN ml.option_id IS NOT NULL THEN qo.label
             ELSE substr(qg.stem, 1, 24) END AS target_label
     FROM media_links ml
     JOIN media_assets ma ON ma.id = ml.media_asset_id
     LEFT JOIN question_options qo ON qo.id = ml.option_id
     LEFT JOIN question_groups qg ON qg.id = ml.group_id
     WHERE ml.question_id = ?
        OR qo.question_id = ?
        OR ml.group_id = ?
     ORDER BY target_type, target_id, ml.sort_order, ml.id`,
    [questionId || -1, questionId || -1, groupId ?? -1],
    ['media_links', 'media_assets', 'question_options', 'question_groups'],
  );
  const questionBlockMedia = useMemo(() => mediaResult.data.filter((media) => (
    media.target_type === 'question' && media.mime_type.startsWith('image/')
  )), [mediaResult.data]);
  const mediaByTarget = useMemo(() => {
    const grouped = new Map<string, MediaRow[]>();
    for (const media of mediaResult.data) {
      const key = `${media.target_type}:${media.target_id}`;
      const siblings = grouped.get(key);
      if (siblings) siblings.push(media);
      else grouped.set(key, [media]);
    }
    return grouped;
  }, [mediaResult.data]);
  const changeContentBlocks = useCallback((update: (current: ContentBlock[]) => ContentBlock[]) => {
    setDirty(true);
    setBlocks(update);
  }, []);

  const hydrateQuestion = useCallback((nextEditing: boolean) => {
    if (!question) return;
    const nextOptions = optionsResult.data.length ? optionsResult.data : blankOptions();
    const nextKnowledgePointIds = linksResult.data.map((row) => row.knowledge_point_id);
    const nextGroupId = groupLinkResult.data[0]?.group_id ?? null;
    const nextBlocks = blocksResult.data;
    const nextAnswerText = readAnswer(question.question_type_code, question.answer_json);
    setType(question.question_type_code);
    setStatus(question.status);
    setOriginalStatus(question.status);
    setStem(question.stem);
    setExplanation(question.explanation);
    setDifficulty(String(question.difficulty));
    setScore(String(question.default_score));
    setAnswerText(nextAnswerText);
    setOptions(nextOptions);
    setKnowledgePointIds(nextKnowledgePointIds);
    setGroupId(nextGroupId);
    setBlocks(nextBlocks);
    setMediaNotes({});
    setDirty(false);
    setEditing(nextEditing);
  }, [
    blocksResult.data,
    groupLinkResult.data,
    linksResult.data,
    optionsResult.data,
    question,
  ]);

  useEffect(() => {
    if (isNew) return;
    if (
      question &&
      bank &&
      !optionsResult.loading &&
      !linksResult.loading &&
      !groupLinkResult.loading &&
      !blocksResult.loading &&
      initialized.current !== question.id
    ) {
      hydrateQuestion(params.edit === '1');
      initialized.current = question.id;
    }
  }, [
    isNew,
    bank,
    question,
    params.edit,
    optionsResult.loading,
    optionsResult.data,
    linksResult.loading,
    linksResult.data,
    groupLinkResult.loading,
    groupLinkResult.data,
    blocksResult.loading,
    blocksResult.data,
    hydrateQuestion,
  ]);
  useEffect(() => () => aiController.current?.abort(), []);
  useEffect(() => {
    setKnowledgePage(0);
    setGroupPage(0);
    setVersionPage(0);
  }, [bankId, questionId]);

  const allowedStatuses: QuestionStatus[] = isNew
    ? ['draft']
    : originalStatus === 'draft'
      ? ['draft', 'active']
      : originalStatus === 'active'
        ? ['active', 'archived']
        : ['archived'];
  const isChoice = type === 'single_choice' || type === 'multiple_choice';
  const mediaTargetLabel = (media: MediaRow) => media.target_type === 'question'
    ? tr('Question', '试题')
    : media.target_type === 'option'
      ? tr(`Option ${media.target_label}`, `选项 ${media.target_label}`)
      : tr(`Group: ${media.target_label}`, `题组：${media.target_label}`);

  const chooseType = (nextType: QuestionType) => {
    if (nextType === type) return;
    setDirty(true);
    setType(nextType);
    setAnswerText(nextType === 'true_false' ? answerToText(nextType, { values: ['true'] }) : '');
  };
  const toggleKnowledge = (id: number) => {
    setDirty(true);
    setKnowledgePointIds((current) => (
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    ));
  };
  const updateOption = (index: number, content: string) => {
    setDirty(true);
    setOptions((current) => (
      current.map((option, optionIndex) => optionIndex === index ? { ...option, content } : option)
    ));
  };
  const removeOption = (index: number) => {
    setDirty(true);
    setOptions((current) => current.filter((_, optionIndex) => optionIndex !== index).map((option, optionIndex) => ({
      ...option,
      sort_order: optionIndex,
    })));
  };
  const save = async (archiveConfirmed = false) => {
    if (Object.keys(mediaNotes).length) {
      return NativeAlert.alert(
        tr('Save media descriptions first', '请先保存媒体说明'),
        tr('A media accessibility description is still being edited.', '仍有媒体辅助说明尚未保存。'),
      );
    }
    const difficultyValue = Number(difficulty);
    const scoreValue = Number(score);
    if (!bankId || !bank) return NativeAlert.alert(tr('Unable to save', '无法保存'), tr('The bank or subject is invalid.', '题库或学科无效。'));
    if (!Number.isInteger(difficultyValue) || difficultyValue < 1 || difficultyValue > 5) {
      return NativeAlert.alert(tr('Unable to save', '无法保存'), tr('Difficulty must be an integer from 1 to 5.', '难度必须是 1 到 5 的整数。'));
    }
    if (!Number.isFinite(scoreValue) || scoreValue < 0) return NativeAlert.alert(tr('Unable to save', '无法保存'), tr('Score must be at least 0.', '分值必须大于或等于 0。'));
    if (!allowedStatuses.includes(status)) return NativeAlert.alert(tr('Unable to save', '无法保存'), tr('Status can only move from Draft to Published to Archived.', '状态只能按草稿、已发布、已归档的顺序流转。'));
    if (originalStatus === 'active' && status === 'archived' && !archiveConfirmed) {
      return NativeAlert.alert(
        tr('Archive this question?', '归档这道试题？'),
        tr('An archived question cannot be published again, but previous practice results will be kept.', '归档后不能恢复为已发布状态，但历史练习结果会保留。'),
        [
          { text: tr('Cancel', '取消'), style: 'cancel' },
          { text: tr('Archive', '归档'), style: 'destructive', onPress: () => void save(true) },
        ],
      );
    }

    setSaving(true);
    try {
      const id = await saveQuestion(db, {
        id: isNew ? undefined : questionId,
        bankId,
        subjectId: bank.subject_id,
        type,
        stem,
        explanation,
        status,
        difficulty: difficultyValue,
        score: scoreValue,
        options: isChoice ? options : [],
        answer: makeAnswer(type, answerText),
        knowledgePointIds,
        groupId,
        blocks,
      });
      setDirty(false);
      setOriginalStatus(status);
      setEditing(false);
      if (isNew) {
        runWithoutPrompt(() => router.replace({
          pathname: '/questions/[questionId]',
          params: { questionId: String(id), bankId: String(bankId) },
        }));
      } else {
        setOptions(await db.getAllAsync<QuestionOption>(
          'SELECT id, label, content, sort_order FROM question_options WHERE question_id = ? ORDER BY sort_order, id',
          questionId,
        ));
        NativeAlert.alert(tr('Saved', '已保存'), tr('The question was updated.', '试题内容已更新。'));
      }
    } catch (error) {
      NativeAlert.alert(tr('Save failed', '保存失败'), error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const addMedia = async () => {
    if (!questionId) return;
    setImporting(true);
    try {
      const id = Number(mediaTarget.slice(mediaTarget.indexOf(':') + 1));
      const target: MediaTarget = mediaTarget === 'question'
        ? { questionId }
        : mediaTarget.startsWith('option:')
          ? { optionId: id }
          : { groupId: id };
      await importMedia(db, target);
    } catch (error) {
      NativeAlert.alert(tr('Media import failed', '媒体导入失败'), error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

  const saveMediaNote = async (media: MediaRow) => {
    try {
      await updateMediaAnnotation(db, media.id, mediaNotes[media.id] ?? metadataText(media.metadata_json));
      setMediaNotes((current) => {
        const next = { ...current };
        delete next[media.id];
        return next;
      });
    } catch (error) {
      NativeAlert.alert(tr('Failed to save description', '说明保存失败'), error instanceof Error ? error.message : String(error));
    }
  };

  const moveMedia = async (media: MediaRow, direction: -1 | 1) => {
    try {
      await moveMediaLink(db, media.link_id, direction);
    } catch (error) {
      NativeAlert.alert(tr('Reordering failed', '排序失败'), error instanceof Error ? error.message : String(error));
    }
  };

  const removeMedia = (media: MediaRow) => NativeAlert.alert(
    tr('Unlink this media?', '解除媒体关联？'),
    tr(
      `"${media.file_name}" will be removed from ${mediaTargetLabel(media)}. The media will be kept if another link or content block still uses it; otherwise, it will be deleted from this device.`,
      `将从${mediaTargetLabel(media)}移除“${media.file_name}”。若其他关联或内容块仍在使用，素材会保留；否则将从本机删除。`,
    ),
    [
      { text: tr('Cancel', '取消'), style: 'cancel' },
      {
        text: tr('Unlink', '解除关联'),
        style: 'destructive',
        onPress: () => void unlinkMedia(db, media.link_id).catch((error: unknown) => {
          NativeAlert.alert(tr('Failed to unlink media', '解除关联失败'), error instanceof Error ? error.message : String(error));
        }),
      },
    ],
  );

  const generateAnswer = async () => {
    if (generating) {
      aiController.current?.abort();
      return;
    }
    if (!stem.trim()) return NativeAlert.alert(tr('Unable to generate', '无法生成'), tr('Enter the question stem first.', '请先填写题干。'));
    const cleanOptions = isChoice ? options.filter((option) => option.content.trim()) : [];
    if (isChoice && cleanOptions.length < 2) return NativeAlert.alert(tr('Unable to generate', '无法生成'), tr('A choice question needs at least two complete options.', '选择题至少需要两个完整选项。'));
    if (!(await hasSession())) {
      return NativeAlert.alert(tr('Not signed in', '尚未登录'), tr('Sign in to your PractiQ cloud account first.', '请先登录 PractiQ 云端账户。'), [
        { text: tr('Cancel', '取消'), style: 'cancel' },
        { text: tr('Open Settings', '打开设置'), onPress: () => router.push('/settings/ai') },
      ]);
    }
    NativeAlert.alert(
      tr('Send the question to AI?', '发送题目到 AI？'),
      tr(
        `Recipient: PractiQ cloud service\nEndpoint: ${CLOUD_API_URL}\n\nThe full stem, question type, and all options will be sent to generate an answer and explanation. The current answer and practice history will not be sent; your login credential is used only to authenticate the request.`,
        `接收方：PractiQ 云端服务\n地址：${CLOUD_API_URL}\n\n将发送题干全文、题型和全部选项，用于生成答案与解析。当前答案和练习记录不会发送；登录凭证仅用于请求鉴权。`,
      ),
      [
        { text: tr("Don't send", '不发送'), style: 'cancel' },
        {
          text: tr('Send', '确认发送'),
          onPress: () => void (async () => {
            const controller = new AbortController();
            const authorityGeneration = getCloudAuthorityGeneration();
            aiController.current = controller;
            setGenerating(true);
            try {
              const result = await generateAnswerCloud(
                { stem: stem.trim(), type, options: cleanOptions },
                { abortSignal: controller.signal },
              );
              assertCloudAuthorityCurrent(authorityGeneration);
              setDirty(true);
              setAnswerText(answerToText(type, result.answer));
              if (!explanation.trim()) setExplanation(result.explanation);
              NativeAlert.alert(tr('Answer generated', '答案已生成'), tr(`Confidence: ${Math.round(result.confidence * 100)}%. Review it before saving or publishing.`, `置信度 ${Math.round(result.confidence * 100)}%。请核对后再保存或发布。`));
            } catch (error) {
              NativeAlert.alert(tr('Generation failed', '生成失败'), error instanceof Error ? error.message : String(error));
            } finally {
              aiController.current = null;
              setGenerating(false);
            }
          })(),
        },
      ],
    );
  };

  const makePrimary = async (key: AnswerKey) => {
    setSwitchingKey(key.id);
    try {
      await setPrimaryAnswerKey(db, questionId, key.id);
      const nextAnswerText = readAnswer(type, key.answer_json);
      setAnswerText(nextAnswerText);
    } catch (error) {
      NativeAlert.alert(tr('Switch failed', '切换失败'), error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingKey(0);
    }
  };

  if (!validQuestionId) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Question', '试题') }} />
        <Card className="gap-3">
          <Card.Title>{tr('Invalid question ID', '试题编号无效')}</Card.Title>
          <Button onPress={() => router.replace('/banks')}>{tr('Back to banks', '返回题库')}</Button>
        </Card>
      </ScreenState>
    );
  }
  if ((!isNew && questionResult.loading) || bankResult.loading) {
    return (
      <ScreenState>
        <Stack.Screen options={{ title: tr('Question', '试题') }} />
        <Spinner accessibilityRole="progressbar" accessibilityLabel={tr('Loading question', '正在加载试题')} />
        <Typography color="muted">{tr('Loading question', '正在加载试题')}</Typography>
      </ScreenState>
    );
  }
  const loadError = questionResult.error ?? bankResult.error ?? knowledgeResult.error
    ?? selectedKnowledgeResult.error ?? optionsResult.error ?? linksResult.error ?? groupsResult.error
    ?? selectedGroupResult.error ?? groupLinkResult.error ?? blocksResult.error ?? mediaResult.error;
  if (loadError) {
    return (
      <ScreenState className="rounded-none">
        <Stack.Screen options={{ title: tr('Question', '试题') }} />
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Title>{loadError.message}</Alert.Title></Alert.Content>
        </Alert>
      </ScreenState>
    );
  }
  if ((!isNew && !question) || !bank) {
    return (
      <ScreenState className="rounded-none">
        <Stack.Screen options={{ title: tr('Question', '试题') }} />
        <Card className="gap-3">
          <Card.Title>{isNew ? tr('Bank not found', '题库不存在') : tr('Question not found or not in this bank', '试题不存在或不属于该题库')}</Card.Title>
          <Button onPress={() => router.replace(bankId ? `/banks/${bankId}` : '/banks')}>{tr('Back to bank', '返回题库')}</Button>
        </Card>
      </ScreenState>
    );
  }

  const title = isNew ? tr('New question', '新建试题') : editing ? tr('Edit question', '编辑试题') : tr('Question details', '试题详情');
  const knowledgeRows = knowledgeResult.data.slice(0, SELECTOR_PAGE_SIZE);
  const selectedKnowledgeRows = selectedKnowledgeResult.data;
  const knowledgeChoices = [
    ...selectedKnowledgeRows,
    ...knowledgeRows.filter((row) => !knowledgePointIds.includes(row.id)),
  ];
  const hasMoreKnowledge = knowledgeResult.data.length > SELECTOR_PAGE_SIZE;
  const groupRows = groupsResult.data.slice(0, SELECTOR_PAGE_SIZE);
  const selectedGroup = selectedGroupResult.data[0];
  const groupChoices = selectedGroup && !groupRows.some((row) => row.id === selectedGroup.id)
    ? [selectedGroup, ...groupRows]
    : groupRows;
  const hasMoreGroups = groupsResult.data.length > SELECTOR_PAGE_SIZE;
  const versionRows = versionsResult.data.slice(0, VERSION_PAGE_SIZE);
  const hasMoreVersions = versionsResult.data.length > VERSION_PAGE_SIZE;
  const visibleMedia = editing ? mediaResult.data : mediaResult.data.filter((media) => (
    media.target_type !== 'group' || media.target_id === groupId
  ));
  return (
    <ScreenState pointerEvents={saving ? 'none' : 'auto'}>
        <Stack.Screen options={{ title }} />
        <Typography color="muted">{`${bank.name} · ${questionTypes.find((item) => item.value === type)?.label ?? type}`}</Typography>
        {editing ? (
          <Button isDisabled={saving} onPress={() => void save()}>{saving ? tr('Saving…', '保存中…') : tr('Save', '保存')}</Button>
        ) : <Button variant="secondary" onPress={() => hydrateQuestion(true)}>{tr('Edit', '编辑')}</Button>}
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{tr('Status can only move from Draft to Published to Archived. Options and answer completeness are validated before publishing.', '状态仅允许草稿 → 已发布 → 已归档；发布时会校验选项和答案完整性。')}</Alert.Description>
          </Alert.Content>
        </Alert>

        <Surface variant="secondary">
          <Typography.Heading type="h2">{tr('Basic information', '基本信息')}</Typography.Heading>
          <Typography type="body-sm" weight="semibold">{tr('Status', '状态')}</Typography>
          {editing ? (
            <RadioGroup
              value={status}
              accessibilityLabel={tr('Question status', '试题状态')}
              onValueChange={(value) => {
                setDirty(true);
                setStatus(value as QuestionStatus);
              }}
            >
              {allowedStatuses.map((value) => (
                <RadioGroup.Item key={value} value={value}>{statusLabels[value]}</RadioGroup.Item>
              ))}
            </RadioGroup>
          ) : (
            <Chip color={status === 'active' ? 'success' : status === 'draft' ? 'warning' : 'default'} variant="soft">
              {statusLabels[status]}
            </Chip>
          )}

          <Typography type="body-sm" weight="semibold">{tr('Question type', '题型')}</Typography>
          {editing ? (
            <RadioGroup
              value={type}
              accessibilityLabel={tr('Choose question type', '选择题型')}
              onValueChange={(value) => chooseType(value as QuestionType)}
            >
              {questionTypes.map((item) => (
                <RadioGroup.Item key={item.value} value={item.value}>{item.label}</RadioGroup.Item>
              ))}
            </RadioGroup>
          ) : <Chip color="default" variant="soft">{questionTypes.find((item) => item.value === type)?.label}</Chip>}

          <Typography type="body-sm" weight="semibold">{tr('Subject', '学科')}</Typography>
          <Chip color="default" variant="soft">{bank.subject_name}</Chip>

          <TextField isDisabled={!editing}>
            <Label>{tr('Stem', '题干')}</Label>
            <TextArea
              accessibilityLabel={tr('Stem', '题干')}
              value={stem}
              onChangeText={(value) => {
                setDirty(true);
                setStem(value);
              }}
              maxLength={20_000}
            />
          </TextField>
          <TextField isDisabled={!editing}>
            <Label>{tr('Explanation', '解析')}</Label>
            <TextArea
              accessibilityLabel={tr('Explanation', '解析')}
              value={explanation}
              onChangeText={(value) => {
                setDirty(true);
                setExplanation(value);
              }}
              maxLength={20_000}
            />
          </TextField>
          <TextField isDisabled={!editing}>
            <Label>{tr('Difficulty (1-5)', '难度（1-5）')}</Label>
            <Input
              accessibilityLabel={tr('Difficulty (1-5)', '难度（1-5）')}
              value={difficulty}
              onChangeText={(value) => {
                setDirty(true);
                setDifficulty(value);
              }}
              keyboardType="number-pad"
              maxLength={1}
            />
          </TextField>
          <TextField isDisabled={!editing}>
            <Label>{tr('Score', '分值')}</Label>
            <Input
              accessibilityLabel={tr('Score', '分值')}
              value={score}
              onChangeText={(value) => {
                setDirty(true);
                setScore(value);
              }}
              keyboardType="decimal-pad"
              maxLength={8}
            />
          </TextField>
        </Surface>

        {isChoice ? (
          <Surface className="gap-3 rounded-none p-0" variant="transparent">
            <Typography.Heading type="h2">{tr('Options', '选项')}</Typography.Heading>
            {editing && options.length < OPTION_LABELS.length ? (
              <Button
                variant="ghost"
                onPress={() => {
                  setDirty(true);
                  setOptions((current) => {
                    const label = Array.from(OPTION_LABELS).find((candidate) => (
                      !current.some((option) => option.label.toUpperCase() === candidate)
                    ));
                    return label ? [...current, { label, content: '', sort_order: current.length }] : current;
                  });
                }}
              >
                {tr('Add option', '添加选项')}
              </Button>
            ) : null}
            {options.map((option, index) => (
              <Card className="gap-3" key={`${option.label}-${index}`}>
                <Card.Title>{tr(`Option ${option.label}`, `选项 ${option.label}`)}</Card.Title>
                <TextField isDisabled={!editing}>
                  <Label>{tr(`Option ${option.label}`, `选项 ${option.label}`)}</Label>
                  <Input
                    accessibilityLabel={tr(`Option ${option.label}`, `选项 ${option.label}`)}
                    value={option.content}
                    onChangeText={(value) => updateOption(index, value)}
                    maxLength={20_000}
                  />
                </TextField>
                {editing ? <Button variant="danger" onPress={() => removeOption(index)}>{tr('Remove this option', '移除此选项')}</Button> : null}
              </Card>
            ))}
          </Surface>
        ) : null}

        <Surface variant="secondary">
          <Typography.Heading type="h2">{tr('Answer', '答案')}</Typography.Heading>
          {editing ? (
            <Button variant="ghost" onPress={() => void generateAnswer()}>
              {generating ? tr('Cancel AI request', '取消 AI 请求') : tr('Generate answer with AI', 'AI 生成答案')}
            </Button>
          ) : null}
          {type === 'true_false' && editing ? (
            <RadioGroup
              value={answerText}
              accessibilityLabel={tr('True-or-false answer', '判断题答案')}
              onValueChange={(value) => {
                setDirty(true);
                setAnswerText(value);
              }}
            >
              {trueFalseAnswers.map((item) => (
                <RadioGroup.Item key={item.value} value={item.value}>{item.label}</RadioGroup.Item>
              ))}
            </RadioGroup>
          ) : (
            <TextField isDisabled={!editing}>
              <Label>{type === 'short_answer' ? tr('Reference answer', '参考答案') : tr('Grading answer', '判分答案')}</Label>
              {type === 'short_answer' || type === 'fill_blank' ? (
                <TextArea
                  accessibilityLabel={type === 'short_answer' ? tr('Reference answer', '参考答案') : tr('Grading answer', '判分答案')}
                  value={editing ? answerText : displayAnswer(answerText)}
                  onChangeText={(value) => {
                    setDirty(true);
                    setAnswerText(value);
                  }}
                  maxLength={20_000}
                />
              ) : (
                <Input
                  accessibilityLabel={tr('Grading answer', '判分答案')}
                  value={editing ? answerText : displayAnswer(answerText)}
                  onChangeText={(value) => {
                    setDirty(true);
                    setAnswerText(value);
                  }}
                  maxLength={20_000}
                />
              )}
              {isChoice ? (
                <Description>{tr('For single choice, enter A. For multiple choice, separate answers with commas, such as A,C.', '单选填 A；多选用逗号分隔，例如 A,C。')}</Description>
              ) : type === 'fill_blank' ? (
                <Description>{tr('Separate blanks with semicolons and acceptable answers for one blank with vertical bars, such as 4|four;8.', '分号分隔多个空；竖线分隔同一空的可接受答案，例如 4|四;8。')}</Description>
              ) : null}
            </TextField>
          )}
        </Surface>

        <Surface variant="secondary">
          <Typography.Heading type="h2">{tr('Knowledge points', '知识点')}</Typography.Heading>
          {knowledgeChoices.length ? knowledgeChoices.map((point) => {
            const selected = knowledgePointIds.includes(point.id);
            return editing ? (
              <ControlField
                key={point.id}
                isSelected={selected}
                accessibilityLabel={`${point.name}${selected ? tr(', linked', '，已关联') : tr(', not linked', '，未关联')}`}
                onSelectedChange={() => toggleKnowledge(point.id)}
              >
                <Label>{point.name}</Label>
                <ControlField.Indicator><Checkbox /></ControlField.Indicator>
              </ControlField>
            ) : selected ? <Chip key={point.id} color="default" variant="soft">{point.name}</Chip> : null;
          }) : <Typography color="muted">{tr('This subject has no knowledge points.', '该学科暂无知识点。')}</Typography>}
          {editing && (knowledgePage > 0 || hasMoreKnowledge) ? (
            <Pager
              page={knowledgePage}
              hasNext={hasMoreKnowledge}
              label={tr(`Knowledge point page ${knowledgePage + 1}`, `知识点第 ${knowledgePage + 1} 页`)}
              onPageChange={setKnowledgePage}
              buttonVariant="ghost"
              muted
            />
          ) : null}
        </Surface>

        <Surface variant="secondary">
          <Typography.Heading type="h2">{tr('Question group', '题组')}</Typography.Heading>
          {groupChoices.length ? (
            editing ? (
              <RadioGroup
                value={groupId === null ? 'none' : String(groupId)}
                accessibilityLabel={tr('Choose question group', '选择所属题组')}
                onValueChange={(value) => {
                  setDirty(true);
                  setGroupId(value === 'none' ? null : Number(value));
                  setMediaTarget('question');
                }}
              >
                <RadioGroup.Item value="none">{tr('No group', '不属于题组')}</RadioGroup.Item>
                {groupChoices.map((group) => (
                  <RadioGroup.Item key={group.id} value={String(group.id)} accessibilityLabel={group.stem}>
                    {group.stem.length > 18 ? `${group.stem.slice(0, 18)}…` : group.stem}
                  </RadioGroup.Item>
                ))}
              </RadioGroup>
            ) : groupId === null ? (
              <Typography color="muted">{tr('No group', '不属于题组')}</Typography>
            ) : (
              <Chip color="default" variant="soft">
                {selectedGroup?.stem ?? tr('Unknown group', '未知题组')}
              </Chip>
            )
          ) : <Typography color="muted">{tr('This bank has no question groups. You can create one on the question management page.', '此题库暂无题组，可在试题管理页新建。')}</Typography>}
          {editing && (groupPage > 0 || hasMoreGroups) ? (
            <Pager
              page={groupPage}
              hasNext={hasMoreGroups}
              label={tr(`Question group page ${groupPage + 1}`, `题组第 ${groupPage + 1} 页`)}
              onPageChange={setGroupPage}
              buttonVariant="ghost"
              muted
            />
          ) : null}
        </Surface>

        <Surface className="gap-3" variant="secondary">
          <Typography.Heading type="h2">{tr('Content blocks', '内容块')}</Typography.Heading>
          <ContentBlockEditor
            blocks={blocks}
            media={questionBlockMedia}
            editing={editing}
            owner="question"
            onChange={changeContentBlocks}
          />
        </Surface>

        <Surface className="gap-3 rounded-none p-0" variant="transparent">
          <Typography.Heading type="h2">{tr('Media', '媒体')}</Typography.Heading>
          {editing && !isNew ? (
            <Button variant="ghost" isDisabled={importing} onPress={() => void addMedia()}>
              {importing ? tr('Importing…', '导入中…') : tr('Import media', '导入媒体')}
            </Button>
          ) : null}
          {isNew && editing ? (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content><Alert.Description>{tr('Save the draft first, then import media through the system file picker.', '先保存草稿，再通过系统 Files 选择器导入媒体。')}</Alert.Description></Alert.Content>
            </Alert>
          ) : null}
          {editing && !isNew ? (
            <>
              <Typography type="body-sm" weight="semibold">{tr('Link to', '关联到')}</Typography>
              <RadioGroup
                value={mediaTarget}
                accessibilityLabel={tr('Media link target', '媒体关联目标')}
                onValueChange={setMediaTarget}
              >
                <RadioGroup.Item value="question">{tr('Question', '试题')}</RadioGroup.Item>
                {options.filter((option) => option.id).map((option) => (
                  <RadioGroup.Item key={option.id} value={`option:${option.id}`}>
                    {tr(`Option ${option.label}`, `选项 ${option.label}`)}
                  </RadioGroup.Item>
                ))}
                {selectedGroup ? (
                  <RadioGroup.Item
                    value={`group:${selectedGroup.id}`}
                    accessibilityLabel={tr(`Group: ${selectedGroup.stem}`, `题组：${selectedGroup.stem}`)}
                  >
                    {tr(`Selected group ${selectedGroup.id}`, `当前题组 ${selectedGroup.id}`)}
                  </RadioGroup.Item>
                ) : null}
              </RadioGroup>
              <Typography color="muted">{tr('Save new options before linking media to them.', '新建选项需先保存，之后才可直接关联媒体。')}</Typography>
            </>
          ) : null}
          {visibleMedia.length ? visibleMedia.map((media) => {
            const siblings = mediaByTarget.get(`${media.target_type}:${media.target_id}`) ?? [];
            const position = siblings.findIndex((item) => item.link_id === media.link_id);
            return (
              <Card className="gap-3" key={media.link_id}>
                <Chip color="default" variant="soft">{mediaTargetLabel(media)}</Chip>
                <Typography color="muted">{media.mime_type}</Typography>
                {!editing ? <MediaAttachmentView media={media} /> : <Typography selectable>{media.file_name}</Typography>}
                {editing ? (
                  <>
                    <TextField>
                      <Label>{tr('Accessibility description (for VoiceOver)', '辅助说明（供 VoiceOver）')}</Label>
                      <Input
                        accessibilityLabel={tr('Accessibility description (for VoiceOver)', '辅助说明（供 VoiceOver）')}
                        value={mediaNotes[media.id] ?? metadataText(media.metadata_json)}
                        onChangeText={(value) => setMediaNotes((current) => {
                          const next = { ...current };
                          if (value === metadataText(media.metadata_json)) delete next[media.id];
                          else next[media.id] = value;
                          return next;
                        })}
                        maxLength={500}
                      />
                    </TextField>
                    <Button variant="secondary" onPress={() => void saveMediaNote(media)}>{tr('Save description', '保存说明')}</Button>
                    <Button variant="ghost" isDisabled={position <= 0} onPress={() => void moveMedia(media, -1)}>{tr('Move up', '上移')}</Button>
                    <Button variant="ghost" isDisabled={position < 0 || position === siblings.length - 1} onPress={() => void moveMedia(media, 1)}>{tr('Move down', '下移')}</Button>
                    <Button variant="danger" onPress={() => removeMedia(media)}>{tr('Unlink', '解除关联')}</Button>
                  </>
                ) : null}
              </Card>
            );
          }) : <Typography color="muted">{tr('No linked media.', '暂无关联媒体。')}</Typography>}
        </Surface>

        {!isNew ? (
          <Surface className="gap-3 rounded-none p-0" variant="transparent">
            <Typography.Heading type="h2">{tr('Answer versions', '答案版本')}</Typography.Heading>
            {versionsResult.error ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content><Alert.Title>{versionsResult.error.message}</Alert.Title></Alert.Content>
              </Alert>
            ) : versionRows.map((key) => (
              <Card className="gap-3" key={key.id}>
                <Card.Title>{tr(`Version ${key.version}`, `版本 ${key.version}`)}</Card.Title>
                {key.is_primary ? <Chip color="success" variant="soft">{tr('Current grading version', '当前判分版本')}</Chip> : null}
                <Typography>{displayAnswer(readAnswer(type, key.answer_json)) || tr('Empty answer', '空答案')}</Typography>
                <Typography color="muted">{tr(`Created ${formatDate(key.created_at, language)}`, `创建于 ${formatDate(key.created_at, language)}`)}</Typography>
                {!key.is_primary && !editing ? (
                  <Button variant="ghost" isDisabled={switchingKey > 0} onPress={() => void makePrimary(key)}>
                    {switchingKey === key.id ? tr('Switching…', '切换中…') : tr('Use for grading', '设为判分答案')}
                  </Button>
                ) : null}
              </Card>
            ))}
            {versionPage > 0 || hasMoreVersions ? (
              <Pager
                page={versionPage}
                hasNext={hasMoreVersions}
                label={tr(`Answer version page ${versionPage + 1}`, `答案版本第 ${versionPage + 1} 页`)}
                onPageChange={setVersionPage}
                buttonVariant="ghost"
                muted
              />
            ) : null}
          </Surface>
        ) : null}

        <Surface className="gap-3" variant="tertiary">
          {editing ? (
            <>
              <Button isDisabled={saving} onPress={() => void save()}>{saving ? tr('Saving…', '保存中…') : tr('Save question', '保存试题')}</Button>
              <Button
                variant="ghost"
                onPress={() => confirmDiscard(() => isNew ? router.back() : hydrateQuestion(false))}
              >
                {tr('Cancel', '取消')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onPress={() => hydrateQuestion(true)}>{tr('Edit question', '编辑试题')}</Button>
              <Button variant="ghost" onPress={() => router.replace(`/banks/${bankId}/manage`)}>{tr('Back to bank', '返回题库')}</Button>
            </>
          )}
        </Surface>
    </ScreenState>
  );
}
