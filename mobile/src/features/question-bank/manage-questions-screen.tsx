import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { memo, useCallback, useEffect, useState } from 'react';
import { Alert as NativeAlert, FlatList } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Dialog } from 'heroui-native/dialog';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { RadioGroup } from 'heroui-native/radio-group';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { TextArea } from 'heroui-native/text-area';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';
import { useThemeColor } from 'heroui-native/hooks';
import { CornerDownRight } from 'lucide-react-native';

import { Pager } from '@/components/pager';
import { ScreenState } from '@/components/screen-state';
import { useFocusedLiveQuery, writeTransaction } from '@/database';
import { saveGroupContentBlocks, saveKnowledgePoint, saveQuestionGroup, swapGroupQuestionOrder } from './actions';
import { importMedia, pruneOrphanMedia } from '@/files/media';
import { formatDate, questionTypeLabel } from '@/i18n';
import { useLanguage } from '@/language';
import { LIST_CONTENT_STYLE } from '@/layout';
import type { ContentBlock, MediaAttachment, Question, QuestionStatus, QuestionType } from '@/types';
import { useUnsavedChanges } from '@/use-unsaved-changes';
import { ContentBlockEditor } from './content-block-editor';

const PAGE_SIZE = 20;
const GROUP_PAGE_SIZE = 10;
const GROUP_CHILD_PAGE_SIZE = 10;

const QuestionListCard = memo(function QuestionListCard({
  question,
  onOpen,
  onRemove,
}: {
  question: Question;
  onOpen: (questionId: string, edit?: boolean) => void;
  onRemove: (question: Question) => void;
}) {
  const { language, tr } = useLanguage();
  return (
    <Card className="gap-3">
      <Chip>{questionTypeLabel(question.question_type_code, language)}</Chip>
      <Chip color={question.status === 'active' ? 'success' : question.status === 'draft' ? 'warning' : 'default'} variant="soft">
        {question.status === 'active' ? tr('Published', '已发布') : question.status === 'draft' ? tr('Draft', '草稿') : tr('Archived', '已归档')}
      </Chip>
      <Typography color="muted">{tr(`${question.subject_name} · ${question.default_score} points`, `${question.subject_name} · ${question.default_score} 分`)}</Typography>
      <Typography>{question.stem}</Typography>
      <Typography color="muted">{tr(`Updated ${formatDate(question.updated_at, language)}`, `更新于 ${formatDate(question.updated_at, language)}`)}</Typography>
      <Button variant="ghost" onPress={() => onOpen(String(question.id))}>{tr('View', '查看')}</Button>
      <Button variant="secondary" onPress={() => onOpen(String(question.id), true)}>{tr('Edit', '编辑')}</Button>
      <Button
        variant="danger"
        accessibilityLabel={tr(`Delete question: ${question.stem}`, `删除试题：${question.stem}`)}
        onPress={() => onRemove(question)}
      >
        {tr('Delete', '删除')}
      </Button>
    </Card>
  );
});

interface BankRow {
  name: string;
}

interface CountRow {
  total: number;
}

interface TypeRow {
  code: QuestionType;
}

interface GroupRow {
  id: number;
  stem: string;
  status: QuestionStatus;
  question_count: number;
  active_question_count: number;
}

interface GroupChildRow {
  id: number;
  stem: string;
  status: QuestionStatus;
  sort_order: number;
}

interface KnowledgeRow {
  id: number;
  parent_id: number | null;
  name: string;
  depth: number;
  child_count: number;
  question_count: number;
}

interface TextEditor {
  kind: 'group' | 'knowledge';
  id: number | null;
  parentId: number | null;
  value: string;
}

function GroupContentEditor({ group, onClose }: { group: GroupRow; onClose: () => void }) {
  const db = useSQLiteContext();
  const { tr } = useLanguage();
  const [blocks, setBlocks] = useState<ContentBlock[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const { confirmDiscard } = useUnsavedChanges(dirty);
  const blocksResult = useFocusedLiveQuery<ContentBlock>(
    `SELECT qcb.id, qcb.kind, qcb.content, qcb.metadata_json, qcb.media_asset_id, qcb.sort_order,
       ma.uri AS media_uri, ma.mime_type AS media_mime_type, ma.file_name AS media_file_name
     FROM question_content_blocks qcb
     LEFT JOIN media_assets ma ON ma.id = qcb.media_asset_id
     WHERE qcb.group_id = ? ORDER BY qcb.sort_order, qcb.id`,
    [group.id],
    ['question_content_blocks', 'media_assets'],
  );
  const mediaResult = useFocusedLiveQuery<MediaAttachment>(
    `SELECT ma.id, ma.file_name, ma.uri, ma.mime_type
     FROM media_links ml JOIN media_assets ma ON ma.id = ml.media_asset_id
     WHERE ml.group_id = ? AND ma.mime_type LIKE 'image/%'
     ORDER BY ml.sort_order, ml.id`,
    [group.id],
    ['media_links', 'media_assets'],
  );

  useEffect(() => {
    if (!blocksResult.loading && blocks === null) setBlocks(blocksResult.data);
  }, [blocks, blocksResult.data, blocksResult.loading]);

  const changeBlocks = useCallback((update: (current: ContentBlock[]) => ContentBlock[]) => {
    setDirty(true);
    setBlocks((current) => update(current ?? []));
  }, []);
  const addMedia = async () => {
    setImporting(true);
    try {
      await importMedia(db, { groupId: group.id }, 'image');
    } catch (error) {
      NativeAlert.alert(tr('Media import failed', '媒体导入失败'), error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };
  const save = async () => {
    if (!blocks) return;
    setSaving(true);
    try {
      await saveGroupContentBlocks(db, group.id, blocks);
      setBlocks(blocks
        .filter((block) => block.content.trim() || block.media_asset_id)
        .map((block, sort_order) => ({ ...block, sort_order })));
      setDirty(false);
      NativeAlert.alert(tr('Saved', '已保存'), tr('Question group content was updated.', '题组内容已更新。'));
    } catch (error) {
      NativeAlert.alert(tr('Save failed', '保存失败'), error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  if (blocksResult.error || mediaResult.error) {
    return (
      <Alert status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{(blocksResult.error ?? mediaResult.error)?.message ?? tr('Failed to load question group content', '读取题组内容失败')}</Alert.Title>
        </Alert.Content>
      </Alert>
    );
  }
  if (blocks === null) {
    return (
      <Surface>
        <Spinner />
        <Typography color="muted">{tr('Loading question group content', '正在读取题组内容')}</Typography>
      </Surface>
    );
  }
  return (
    <Surface className="gap-3" pointerEvents={saving ? 'none' : 'auto'}>
      <Typography.Heading type="h3">{tr('Question group content', '题组内容')}</Typography.Heading>
      <Button
        variant="ghost"
        isDisabled={importing}
        onPress={() => void addMedia()}
      >
        {importing ? tr('Importing...', '导入中...') : tr('Import group image', '导入题组图片')}
      </Button>
      <Alert status="default">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{tr('Images, charts, and QR codes can use images linked to this group. Other formats retain their original text.', '图片、图表和 QR 码可选择已关联到本题组的图片；其他格式保留原始文本。')}</Alert.Description>
        </Alert.Content>
      </Alert>
      <ContentBlockEditor
        blocks={blocks}
        media={mediaResult.data}
        editing
        owner="group"
        onChange={changeBlocks}
      />
      <Button isDisabled={saving || !dirty} onPress={() => void save()}>
        {saving ? tr('Saving...', '保存中...') : tr('Save content', '保存内容')}
      </Button>
      <Button variant="ghost" isDisabled={saving} onPress={() => confirmDiscard(onClose)}>{tr('Close', '关闭')}</Button>
    </Surface>
  );
}

function GroupChildren({
  bankId,
  groupId,
  onOpen,
}: {
  bankId: number;
  groupId: number;
  onOpen: (questionId: number) => void;
}) {
  const db = useSQLiteContext();
  const { tr } = useLanguage();
  const [page, setPage] = useState(0);
  const pageStart = page * GROUP_CHILD_PAGE_SIZE;
  const includesPrevious = page > 0;
  const children = useFocusedLiveQuery<GroupChildRow>(
    `SELECT q.id, q.stem, q.status, gql.sort_order
     FROM group_question_links gql
     JOIN questions q ON q.id = gql.question_id
     JOIN bank_question_links bql ON bql.question_id = q.id AND bql.bank_id = ?
     WHERE gql.group_id = ? ORDER BY gql.sort_order, q.id LIMIT ? OFFSET ?`,
    [
      bankId,
      groupId,
      GROUP_CHILD_PAGE_SIZE + 1 + (includesPrevious ? 1 : 0),
      Math.max(0, pageStart - 1),
    ],
    ['group_question_links', 'questions', 'bank_question_links'],
  );
  const rowStart = includesPrevious ? 1 : 0;
  const rows = children.data.slice(rowStart, rowStart + GROUP_CHILD_PAGE_SIZE);
  const previous = includesPrevious ? children.data[0] : undefined;
  const next = children.data[rowStart + GROUP_CHILD_PAGE_SIZE];
  useEffect(() => {
    if (page > 0 && !children.loading && !rows.length) setPage((value) => Math.max(0, value - 1));
  }, [children.loading, page, rows.length]);
  const move = async (index: number, direction: -1 | 1) => {
    const current = rows[index];
    const neighbor = direction === -1
      ? rows[index - 1] ?? previous
      : rows[index + 1] ?? next;
    if (!current || !neighbor) return;
    try {
      await swapGroupQuestionOrder(
        db,
        groupId,
        current.id,
        current.sort_order,
        neighbor.id,
        neighbor.sort_order,
      );
    } catch (error) {
      NativeAlert.alert(tr('Reorder failed', '排序失败'), error instanceof Error ? error.message : String(error));
    }
  };

  if (children.error) {
    return (
      <Alert status="danger">
        <Alert.Indicator />
        <Alert.Content><Alert.Title>{tr('Failed to load questions in this group.', '读取题组子题失败。')}</Alert.Title></Alert.Content>
      </Alert>
    );
  }
  if (children.loading) {
    return (
      <Surface>
        <Spinner />
        <Typography color="muted">{tr('Loading questions', '正在读取子题')}</Typography>
      </Surface>
    );
  }
  if (!rows.length) return <Typography color="muted">{tr('No questions have been arranged yet.', '尚未编排子题。')}</Typography>;
  return (
    <Surface className="gap-3 rounded-none p-0" variant="transparent">
      <Typography.Heading type="h4">{tr('Question order', '子题顺序')}</Typography.Heading>
      {rows.map((question, index) => (
        <Card className="gap-3" key={question.id}>
          <Typography numberOfLines={2}>{pageStart + index + 1}. {question.stem}</Typography>
          <Chip color={question.status === 'active' ? 'success' : question.status === 'draft' ? 'warning' : 'default'} variant="soft">
            {question.status === 'active' ? tr('Published', '已发布') : question.status === 'draft' ? tr('Draft', '草稿') : tr('Archived', '已归档')}
          </Chip>
          <Button variant="ghost" isDisabled={!rows[index - 1] && !previous} onPress={() => void move(index, -1)}>{tr('Move up', '上移')}</Button>
          <Button variant="ghost" isDisabled={!rows[index + 1] && !next} onPress={() => void move(index, 1)}>{tr('Move down', '下移')}</Button>
          <Button variant="ghost" onPress={() => onOpen(question.id)}>{tr('Edit', '编辑')}</Button>
        </Card>
      ))}
      {page > 0 || next ? (
        <Pager
          page={page}
          hasNext={Boolean(next)}
          label={tr(`Question page ${page + 1}`, `子题第 ${page + 1} 页`)}
          onPageChange={setPage}
          buttonVariant="ghost"
          muted
        />
      ) : null}
    </Surface>
  );
}

export default function ManageQuestionsPage() {
  const db = useSQLiteContext();
  const { language, tr } = useLanguage();
  const foregroundColor = useThemeColor('foreground');
  const { bankId: rawBankId } = useLocalSearchParams<{ bankId: string }>();
  const bankId = Number(rawBankId);
  const validBankId = Number.isInteger(bankId) && bankId > 0;
  const [status, setStatus] = useState<'all' | QuestionStatus>('all');
  const [type, setType] = useState<'all' | QuestionType>('all');
  const [page, setPage] = useState(0);
  const [groupPage, setGroupPage] = useState(0);
  const [knowledgePage, setKnowledgePage] = useState(0);
  const [expandedGroupId, setExpandedGroupId] = useState<number | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [textEditor, setTextEditor] = useState<TextEditor | null>(null);
  const [textSaving, setTextSaving] = useState(false);
  const statuses: { value: 'all' | QuestionStatus; label: string }[] = [
    { value: 'all', label: tr('All statuses', '全部状态') },
    { value: 'draft', label: tr('Draft', '草稿') },
    { value: 'active', label: tr('Published', '已发布') },
    { value: 'archived', label: tr('Archived', '已归档') },
  ];

  useEffect(() => setPage(0), [status, type]);

  const bankResult = useFocusedLiveQuery<BankRow>(
    'SELECT name FROM question_banks WHERE id = ?',
    [validBankId ? bankId : -1],
    ['question_banks'],
  );
  const typesResult = useFocusedLiveQuery<TypeRow>(
    'SELECT code FROM question_types ORDER BY sort_order',
    [],
    ['question_types'],
  );
  const groupsResult = useFocusedLiveQuery<GroupRow>(
    `WITH page AS (
       SELECT group_id, sort_order FROM bank_group_links
       WHERE bank_id = ? ORDER BY sort_order, group_id LIMIT ? OFFSET ?
     )
     SELECT qg.id, qg.stem, qg.status, COUNT(gql.question_id) AS question_count,
       SUM(CASE WHEN q.status = 'active' THEN 1 ELSE 0 END) AS active_question_count
     FROM page
     JOIN question_groups qg ON qg.id = page.group_id
     LEFT JOIN group_question_links gql ON gql.group_id = qg.id
     LEFT JOIN questions q ON q.id = gql.question_id
     GROUP BY qg.id ORDER BY page.sort_order, qg.id`,
    [validBankId ? bankId : -1, GROUP_PAGE_SIZE + 1, groupPage * GROUP_PAGE_SIZE],
    ['bank_group_links', 'question_groups', 'group_question_links', 'questions'],
  );
  const knowledgeResult = useFocusedLiveQuery<KnowledgeRow>(
    `WITH RECURSIVE tree(id, parent_id, name, sort_order, depth, path) AS (
       SELECT kp.id, kp.parent_id, kp.name, kp.sort_order, 0,
         printf('%08d-%08d', kp.sort_order, kp.id)
       FROM knowledge_points kp
       WHERE kp.subject_id = (SELECT subject_id FROM question_banks WHERE id = ?)
         AND kp.parent_id IS NULL
       UNION ALL
       SELECT child.id, child.parent_id, child.name, child.sort_order, tree.depth + 1,
         tree.path || '/' || printf('%08d-%08d', child.sort_order, child.id)
       FROM knowledge_points child JOIN tree ON child.parent_id = tree.id
     )
     SELECT tree.id, tree.parent_id, tree.name, tree.depth,
       (SELECT COUNT(*) FROM knowledge_points child WHERE child.parent_id = tree.id) AS child_count,
       (SELECT COUNT(*) FROM question_knowledge_links qkl WHERE qkl.knowledge_point_id = tree.id) AS question_count
     FROM tree ORDER BY tree.path LIMIT ? OFFSET ?`,
    [validBankId ? bankId : -1, PAGE_SIZE + 1, knowledgePage * PAGE_SIZE],
    ['knowledge_points', 'question_knowledge_links', 'question_banks'],
  );
  const countResult = useFocusedLiveQuery<CountRow>(
    `SELECT COUNT(*) AS total
     FROM bank_question_links bql
     JOIN questions q ON q.id = bql.question_id
     WHERE bql.bank_id = ?
       AND (? = 'all' OR q.status = ?)
       AND (? = 'all' OR q.question_type_code = ?)`,
    [validBankId ? bankId : -1, status, status, type, type],
    ['bank_question_links', 'questions'],
  );
  const questionsResult = useFocusedLiveQuery<Question>(
    `SELECT q.id, q.question_type_code, s.name AS subject_name, q.stem, q.status,
       q.default_score, q.updated_at
     FROM bank_question_links bql
     JOIN questions q ON q.id = bql.question_id
     JOIN subjects s ON s.id = q.subject_id
     WHERE bql.bank_id = ?
       AND (? = 'all' OR q.status = ?)
       AND (? = 'all' OR q.question_type_code = ?)
     ORDER BY bql.sort_order, q.id
     LIMIT ? OFFSET ?`,
    [validBankId ? bankId : -1, status, status, type, type, PAGE_SIZE, page * PAGE_SIZE],
    ['bank_question_links', 'questions', 'subjects'],
  );

  const total = countResult.data[0]?.total ?? 0;
  const groupRows = groupsResult.data.slice(0, GROUP_PAGE_SIZE);
  const hasMoreGroups = groupsResult.data.length > GROUP_PAGE_SIZE;
  const knowledgeRows = knowledgeResult.data.slice(0, PAGE_SIZE);
  const hasMoreKnowledge = knowledgeResult.data.length > PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);
  useEffect(() => {
    if (groupPage > 0 && !groupsResult.loading && !groupRows.length) {
      setGroupPage((value) => Math.max(0, value - 1));
    }
  }, [groupPage, groupRows.length, groupsResult.loading]);

  const openQuestion = useCallback((questionId: string, edit = false) =>
    router.push({
      pathname: '/questions/[questionId]',
      params: { questionId, bankId: String(bankId), ...(edit ? { edit: '1' } : {}) },
    }), [bankId]);

  const remove = useCallback((question: Question) => NativeAlert.alert(
    tr('Delete this question?', '删除这道试题？'),
    tr('The question will be deleted from every bank. Questions with practice history cannot be deleted but can be archived. This cannot be undone.', '试题会从所有题库中删除，已有练习记录时将无法删除，可改为归档。此操作无法撤销。'),
    [
      { text: tr('Cancel', '取消'), style: 'cancel' },
      {
        text: tr('Delete', '删除'),
        style: 'destructive',
        onPress: () => void (async () => {
          await writeTransaction(db, undefined, (transaction) => (
            transaction.runAsync('DELETE FROM questions WHERE id = ?', question.id)
          ));
          await pruneOrphanMedia(db);
        })().catch((error: unknown) => {
          NativeAlert.alert(tr('Unable to delete', '无法删除'), String(error).includes('FOREIGN KEY') ? tr('This question has practice history. Archive it instead.', '这道题已有练习记录，请改为归档。') : String(error));
        }),
      },
    ],
  ), [db, tr]);
  const editGroup = (group?: GroupRow) => setTextEditor({
    kind: 'group',
    id: group?.id ?? null,
    parentId: null,
    value: group?.stem ?? '',
  });
  const advanceGroup = (group: GroupRow) => {
    if (group.status === 'draft' && !group.question_count) {
      return NativeAlert.alert(tr('Unable to publish', '无法发布'), tr('A question group needs at least one question. Edit a question and select this group.', '题组至少需要一道子题。请编辑试题并选择这个题组。'));
    }
    if (group.status === 'active' && group.active_question_count) {
      return NativeAlert.alert(tr('Unable to archive', '无法归档'), tr(`Archive the ${group.active_question_count} published questions in this group first so their group material remains available during practice.`, `请先归档题组内 ${group.active_question_count} 道已发布子题，避免练习时失去题组材料。`));
    }
    const next = group.status === 'draft' ? 'active' : 'archived';
    const action = next === 'active' ? tr('Publish', '发布') : tr('Archive', '归档');
    NativeAlert.alert(tr(`${action} question group?`, `${action}题组？`), next === 'active' ? tr('After publication, the group material will appear with its questions.', '发布后题组材料将随子题展示。') : tr('Archiving the group will not delete its questions.', '归档后不会删除子题。'), [
      { text: tr('Cancel', '取消'), style: 'cancel' },
      {
        text: action,
        onPress: () => void writeTransaction(db, ['question_groups'], (transaction) => transaction.runAsync(
          'UPDATE question_groups SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?',
          next,
          group.id,
          group.status,
        )).catch((error: unknown) => NativeAlert.alert(tr(`${action} failed`, `${action}失败`), error instanceof Error ? error.message : String(error))),
      },
    ]);
  };
  const removeGroup = (group: GroupRow) => NativeAlert.alert(
    tr('Delete question group?', '删除题组？'),
    tr('Only the group and its arrangement will be deleted. Its questions will remain in the bank.', '只删除题组及其编排关系，子题仍保留在题库中。'),
    [
      { text: tr('Cancel', '取消'), style: 'cancel' },
      {
        text: tr('Delete', '删除'),
        style: 'destructive',
        onPress: () => void (async () => {
          await writeTransaction(db, undefined, (transaction) => (
            transaction.runAsync('DELETE FROM question_groups WHERE id = ?', group.id)
          ));
          await pruneOrphanMedia(db);
        })().catch((error: unknown) => NativeAlert.alert(tr('Unable to delete', '无法删除'), error instanceof Error ? error.message : String(error))),
      },
    ],
  );
  const editKnowledge = (parentId: number | null, point?: KnowledgeRow) => setTextEditor({
    kind: 'knowledge',
    id: point?.id ?? null,
    parentId,
    value: point?.name ?? '',
  });
  const saveTextEditor = async () => {
    if (!textEditor) return;
    const value = textEditor.value.trim();
    const maxLength = textEditor.kind === 'group' ? 20_000 : 200;
    if (!value || value.length > maxLength) {
      return NativeAlert.alert(
        tr('Unable to save', '无法保存'),
        textEditor.kind === 'group'
          ? tr('Question group material must contain 1–20,000 characters.', '题组材料须为 1–20,000 个字符。')
          : tr('The knowledge point name must contain 1–200 characters.', '知识点名称须为 1–200 个字符。'),
      );
    }
    setTextSaving(true);
    try {
      if (textEditor.kind === 'group') {
        await saveQuestionGroup(db, bankId, textEditor.id, value);
      } else {
        const result = await saveKnowledgePoint(db, bankId, textEditor.parentId, textEditor.id, value);
        if (result === 'duplicate') throw new Error(tr('A knowledge point with this name already exists at the same level.', '同一层级已存在同名知识点。'));
        if (result === 'missing') throw new Error(textEditor.id
          ? tr('Knowledge point not found.', '知识点不存在。')
          : tr('The parent knowledge point or bank does not exist.', '父知识点或题库不存在。'));
      }
      setTextEditor(null);
    } catch (error) {
      NativeAlert.alert(tr('Save failed', '保存失败'), error instanceof Error ? error.message : String(error));
    } finally {
      setTextSaving(false);
    }
  };
  const removeKnowledge = (point: KnowledgeRow) => NativeAlert.alert(
    tr('Delete knowledge point?', '删除知识点？'),
    point.child_count
      ? tr(`“${point.name}” and all descendant knowledge points will be deleted. This affects every bank in the subject; related questions will only be unlinked.`, `“${point.name}”及其所有后代知识点会被删除；此操作影响该学科的所有题库，相关试题只会解除知识点关联。`)
      : tr(`“${point.name}” will be deleted. This affects every bank in the subject; ${point.question_count} related questions will only be unlinked.`, `“${point.name}”会被删除；此操作影响该学科的所有题库，${point.question_count} 道相关试题只会解除知识点关联。`),
    [
      { text: tr('Cancel', '取消'), style: 'cancel' },
      {
        text: tr('Delete', '删除'),
        style: 'destructive',
        onPress: () => void writeTransaction(
          db,
          ['knowledge_points', 'question_knowledge_links'],
          (transaction) => transaction.runAsync(
            `DELETE FROM knowledge_points
             WHERE id = ? AND subject_id = (SELECT subject_id FROM question_banks WHERE id = ?)`,
            point.id,
            bankId,
          ),
        ).catch((error: unknown) => NativeAlert.alert(tr('Delete failed', '删除失败'), String(error))),
      },
    ],
  );

  if (!validBankId) {
    return (
      <ScreenState className="rounded-none">
        <Card className="gap-3">
          <Card.Title>{tr('Invalid bank ID', '题库编号无效')}</Card.Title>
          <Button onPress={() => router.replace('/banks')}>{tr('Back to banks', '返回题库')}</Button>
        </Card>
      </ScreenState>
    );
  }
  if (bankResult.loading) {
    return (
      <ScreenState>
        <Spinner />
        <Typography color="muted">{tr('Loading questions', '正在读取试题')}</Typography>
      </ScreenState>
    );
  }
  if (bankResult.error) {
    return (
      <ScreenState className="rounded-none">
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Title>{bankResult.error.message}</Alert.Title></Alert.Content>
        </Alert>
      </ScreenState>
    );
  }
  const bank = bankResult.data[0];
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

  const questionQueryFailed = Boolean(questionsResult.error || countResult.error || typesResult.error);
  const questionQueryLoading = questionsResult.loading || countResult.loading;

  return (
    <>
      <FlatList
        data={questionQueryFailed || questionQueryLoading ? [] : questionsResult.data}
        keyExtractor={(question) => String(question.id)}
        renderItem={({ item }) => (
          <QuestionListCard question={item} onOpen={openQuestion} onRemove={remove} />
        )}
        ListHeaderComponent={(
          <Surface className="gap-4 rounded-none p-0" variant="transparent">
        <Stack.Screen options={{ title: tr('Manage questions', '管理试题') }} />
        <Typography.Heading type="h1">{tr(`${bank.name} · Questions`, `${bank.name} · 试题`)}</Typography.Heading>
        <Button onPress={() => openQuestion('new', true)}>{tr('New question', '新建试题')}</Button>

        <Typography.Heading type="h2">{tr('Question groups', '题组')}</Typography.Heading>
        <Button variant="ghost" onPress={() => editGroup()}>{tr('New question group', '新建题组')}</Button>
        {groupsResult.error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{groupsResult.error.message}</Alert.Title></Alert.Content>
          </Alert>
        ) : groupsResult.loading ? (
          <Surface>
            <Spinner />
            <Typography color="muted">{tr('Loading question groups', '正在加载题组')}</Typography>
          </Surface>
        ) : groupRows.length ? (
          <>
            {groupRows.map((group) => (
              <Card className="gap-3" key={group.id}>
                <Chip color={group.status === 'active' ? 'success' : group.status === 'draft' ? 'warning' : 'default'} variant="soft">
                  {group.status === 'active' ? tr('Published', '已发布') : group.status === 'draft' ? tr('Draft', '草稿') : tr('Archived', '已归档')}
                </Chip>
                <Typography color="muted">{tr(`${group.question_count} questions`, `${group.question_count} 道子题`)}</Typography>
                <Typography>{group.stem}</Typography>
                {expandedGroupId === group.id ? (
                  <GroupChildren bankId={bankId} groupId={group.id} onOpen={(questionId) => openQuestion(String(questionId), true)} />
                ) : null}
                <Button
                  variant="ghost"
                  onPress={() => setExpandedGroupId((current) => current === group.id ? null : group.id)}
                >
                  {expandedGroupId === group.id ? tr('Collapse questions', '收起子题') : tr('Arrange questions', '编排子题')}
                </Button>
                {group.status !== 'archived' ? (
                  <Button
                    variant="ghost"
                    isDisabled={editingGroupId === group.id}
                    onPress={() => editGroup(group)}
                  >
                    {tr('Edit material', '编辑材料')}
                  </Button>
                ) : null}
                {group.status !== 'archived' ? (
                  <Button
                    variant="ghost"
                    isDisabled={editingGroupId !== null}
                    onPress={() => setEditingGroupId(group.id)}
                  >
                    {editingGroupId === group.id ? tr('Editing content', '正在编辑内容') : tr('Edit content', '编辑内容')}
                  </Button>
                ) : null}
                {group.status !== 'archived' ? (
                  <Button
                    variant="secondary"
                    isDisabled={editingGroupId === group.id}
                    onPress={() => advanceGroup(group)}
                  >
                    {group.status === 'draft' ? tr('Publish group', '发布题组') : tr('Archive group', '归档题组')}
                  </Button>
                ) : null}
                <Button
                  variant="danger"
                  isDisabled={editingGroupId === group.id}
                  onPress={() => removeGroup(group)}
                >
                  {tr('Delete group', '删除题组')}
                </Button>
                {editingGroupId === group.id ? (
                  <GroupContentEditor group={group} onClose={() => setEditingGroupId(null)} />
                ) : null}
              </Card>
            ))}
            {groupPage > 0 || hasMoreGroups ? (
              <Pager
                page={groupPage}
                hasNext={hasMoreGroups}
                label={tr(`Question group page ${groupPage + 1}`, `题组第 ${groupPage + 1} 页`)}
                onPageChange={setGroupPage}
                buttonVariant="ghost"
                muted
              />
            ) : null}
          </>
        ) : <Typography color="muted">{tr('No question groups. After creating one, assign questions to it from the question editor.', '暂无题组。新建后可在试题编辑页选择归属题组。')}</Typography>}

        <Typography.Heading type="h2">{tr('Knowledge tree', '知识树')}</Typography.Heading>
        <Button variant="ghost" onPress={() => editKnowledge(null)}>{tr('New knowledge point', '新建知识点')}</Button>
        {knowledgeResult.error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{knowledgeResult.error.message}</Alert.Title></Alert.Content>
          </Alert>
        ) : knowledgeRows.length ? knowledgeRows.map((point) => (
          <Card className="gap-3" key={point.id}>
            <Surface
              className="flex-row items-center gap-1 rounded-none bg-transparent p-0"
              style={{ paddingLeft: Math.min(point.depth, 6) * 16 }}
              variant="transparent"
            >
              {point.depth ? <CornerDownRight accessible={false} color={foregroundColor} size={16} /> : null}
              <Card.Title>{point.name}</Card.Title>
            </Surface>
            <Typography color="muted">{tr(`${point.question_count} linked questions · ${point.child_count} direct children`, `${point.question_count} 道关联试题 · ${point.child_count} 个直接子节点`)}</Typography>
            <Chip>{point.depth === 0 ? tr('Root', '根节点') : tr(`Level ${point.depth + 1}`, `第 ${point.depth + 1} 层`)}</Chip>
            <Button variant="ghost" onPress={() => editKnowledge(point.id)}>{tr('New child', '新建子节点')}</Button>
            <Button variant="secondary" onPress={() => editKnowledge(point.parent_id, point)}>{tr('Edit name', '编辑名称')}</Button>
            <Button variant="danger" onPress={() => removeKnowledge(point)}>{tr('Delete', '删除')}</Button>
          </Card>
        )) : <Typography color="muted">{tr('This subject has no knowledge points.', '此学科还没有知识点。')}</Typography>}
        {knowledgePage > 0 || hasMoreKnowledge ? (
          <Pager
            page={knowledgePage}
            hasNext={hasMoreKnowledge}
            label={tr(`Knowledge point page ${knowledgePage + 1}`, `知识点第 ${knowledgePage + 1} 页`)}
            onPageChange={setKnowledgePage}
            buttonVariant="ghost"
            muted
          />
        ) : null}

        <Typography.Heading type="h2">{tr('Filters', '筛选')}</Typography.Heading>
        <Typography type="body-sm" weight="semibold">{tr('Status', '状态')}</Typography>
        <RadioGroup
          value={status}
          accessibilityLabel={tr('Filter by status', '按状态筛选')}
          onValueChange={(value) => setStatus(value as 'all' | QuestionStatus)}
        >
          {statuses.map((item) => (
            <RadioGroup.Item key={item.value} value={item.value}>{item.label}</RadioGroup.Item>
          ))}
        </RadioGroup>
        <Typography type="body-sm" weight="semibold">{tr('Question type', '题型')}</Typography>
        <RadioGroup
          value={type}
          accessibilityLabel={tr('Filter by question type', '按题型筛选')}
          onValueChange={(value) => setType(value as 'all' | QuestionType)}
        >
          <RadioGroup.Item value="all">{tr('All question types', '全部题型')}</RadioGroup.Item>
          {typesResult.data.map((item) => (
            <RadioGroup.Item key={item.code} value={item.code}>{questionTypeLabel(item.code, language)}</RadioGroup.Item>
          ))}
        </RadioGroup>

        {questionQueryFailed ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{(questionsResult.error ?? countResult.error ?? typesResult.error)?.message ?? tr('Loading failed', '加载失败')}</Alert.Title>
            </Alert.Content>
          </Alert>
        ) : questionQueryLoading ? (
          <Surface>
            <Spinner />
            <Typography color="muted">{tr('Loading questions', '正在加载试题')}</Typography>
          </Surface>
        ) : questionsResult.data.length ? (
          <Typography color="muted" accessibilityLiveRegion="polite">
            {tr(`${total} questions · Page ${page + 1}/${pageCount}`, `共 ${total} 题 · 第 ${page + 1}/${pageCount} 页`)}
          </Typography>
        ) : (
          <Card className="gap-3">
            <Card.Title>{tr('No matching questions', '没有匹配的试题')}</Card.Title>
            <Button onPress={() => openQuestion('new', true)}>{tr('New question', '新建试题')}</Button>
          </Card>
        )}
          </Surface>
        )}
        ListFooterComponent={!questionQueryFailed && !questionQueryLoading && questionsResult.data.length ? (
          <Pager
            page={page}
            hasNext={page + 1 < pageCount}
            label={`${page + 1}/${pageCount}`}
            onPageChange={setPage}
            buttonVariant="ghost"
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
      <Dialog
        isOpen={textEditor !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !textSaving) setTextEditor(null);
        }}
      >
        <Dialog.Portal unstable_accessibilityContainerViewIsModal>
          <Dialog.Overlay isCloseOnPress={!textSaving} />
          <Dialog.Content className="gap-4" isSwipeable={!textSaving}>
            <Dialog.Title>
              {textEditor?.kind === 'group'
                ? textEditor.id
                  ? tr('Edit question group material', '编辑题组材料')
                  : tr('New question group', '新建题组')
                : textEditor?.id
                  ? tr('Edit knowledge point', '编辑知识点')
                  : textEditor?.parentId
                    ? tr('New child knowledge point', '新建子知识点')
                    : tr('New knowledge point', '新建知识点')}
            </Dialog.Title>
            <Dialog.Description>
              {textEditor?.kind === 'group'
                ? tr('Enter reading material, an experiment background, or instructions for a combined question.', '输入阅读材料、实验背景或组合题说明。')
                : textEditor?.id
                  ? tr('Changing the name will not affect linked questions.', '修改名称不会影响已经关联的试题。')
                  : tr('The knowledge point will be created under the subject of the current bank.', '知识点将创建在当前题库的学科下。')}
            </Dialog.Description>
            <TextField isRequired isDisabled={textSaving}>
              <Label>{textEditor?.kind === 'group' ? tr('Material', '材料') : tr('Name', '名称')}</Label>
              {textEditor?.kind === 'group' ? (
                <TextArea
                  autoFocus
                  maxLength={20_000}
                  value={textEditor.value}
                  onChangeText={(value) => setTextEditor((current) => current ? { ...current, value } : current)}
                />
              ) : (
                <Input
                  autoFocus
                  maxLength={200}
                  value={textEditor?.value ?? ''}
                  onChangeText={(value) => setTextEditor((current) => current ? { ...current, value } : current)}
                />
              )}
            </TextField>
            <Surface className="flex-row justify-end gap-3 rounded-none p-0" variant="transparent">
              <Button variant="ghost" isDisabled={textSaving} onPress={() => setTextEditor(null)}>
                {tr('Cancel', '取消')}
              </Button>
              <Button isDisabled={textSaving} onPress={() => void saveTextEditor()}>
                {textSaving ? tr('Saving…', '保存中…') : tr('Save', '保存')}
              </Button>
            </Surface>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </>
  );
}
