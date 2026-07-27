import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Alert as NativeAlert } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { RadioGroup } from 'heroui-native/radio-group';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { TextArea } from 'heroui-native/text-area';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';

import { ScreenState } from '@/components/screen-state';
import { useFocusedLiveQuery } from '@/database';
import { useLanguage } from '@/language';
import type { Subject } from '@/types';
import { useUnsavedChanges } from '@/use-unsaved-changes';
import { saveQuestionBank } from './actions';

export default function BankEditor() {
  const db = useSQLiteContext();
  const { tr } = useLanguage();
  const { bankId: rawBankId } = useLocalSearchParams<{ bankId?: string }>();
  const parsedBankId = Number(rawBankId);
  const invalidBankId = rawBankId !== undefined && (!Number.isInteger(parsedBankId) || parsedBankId <= 0);
  const bankId = invalidBankId ? -1 : parsedBankId || 0;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [subjectId, setSubjectId] = useState('1');
  const [originalSubjectId, setOriginalSubjectId] = useState('1');
  const [subjectLocked, setSubjectLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadState, setLoadState] = useState<'ready' | 'loading' | 'missing' | 'error'>(bankId ? 'loading' : 'ready');
  const [loadError, setLoadError] = useState('');
  const [initial, setInitial] = useState({ name: '', description: '', subjectId: '1' });
  const formDirty = name !== initial.name ||
    description !== initial.description ||
    subjectId !== initial.subjectId;
  const { confirmDiscard, runWithoutPrompt } = useUnsavedChanges(formDirty);
  const subjects = useFocusedLiveQuery<Subject>('SELECT id, name FROM subjects ORDER BY name', [], ['subjects']).data;
  const editorTitle = bankId ? tr('Edit bank', '编辑题库') : tr('Create bank', '创建题库');
  const pageTitle = loadState === 'missing'
    ? tr('Bank not found', '题库不存在')
    : loadState === 'error'
      ? tr('Unable to load bank', '无法读取题库')
      : editorTitle;

  useEffect(() => {
    if (!bankId) {
      setLoadState('ready');
      return;
    }
    let active = true;
    setLoadState('loading');
    void db
      .getFirstAsync<{ name: string; description: string; subject_id: number; subject_locked: number }>(
        `SELECT name, description, subject_id,
           (EXISTS(SELECT 1 FROM bank_question_links WHERE bank_id = question_banks.id)
            OR EXISTS(SELECT 1 FROM bank_group_links WHERE bank_id = question_banks.id)) AS subject_locked
         FROM question_banks WHERE id = ?`,
        bankId,
      )
      .then((bank) => {
        if (!active) return;
        if (!bank) {
          setLoadState('missing');
          return;
        }
        setName(bank.name);
        setDescription(bank.description);
        setSubjectId(String(bank.subject_id));
        setOriginalSubjectId(String(bank.subject_id));
        setSubjectLocked(Boolean(bank.subject_locked));
        setInitial({
          name: bank.name,
          description: bank.description,
          subjectId: String(bank.subject_id),
        });
        setLoadState('ready');
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setLoadError(reason instanceof Error ? reason.message : String(reason));
        setLoadState('error');
      });
    return () => { active = false; };
  }, [bankId, db]);

  const save = async () => {
    const cleanName = name.trim();
    if (!cleanName) return NativeAlert.alert(tr('Unable to save', '无法保存'), tr('Enter a bank name.', '请输入题库名称。'));
    if (cleanName.length > 100) return NativeAlert.alert(tr('Unable to save', '无法保存'), tr('The bank name cannot exceed 100 characters.', '题库名称不能超过 100 个字符。'));
    if (subjectLocked && subjectId !== originalSubjectId) {
      return NativeAlert.alert(tr('Unable to change subject', '无法更改学科'), tr('This bank already contains questions or question groups. Its subject cannot be changed so knowledge points and practice data remain consistent.', '题库已有试题或题组。为保持知识点和练习数据一致，学科不能再更改。'));
    }
    setSaving(true);
    try {
      const id = await saveQuestionBank(db, bankId, Number(subjectId), cleanName, description.trim());
      if (id === null) throw new Error(tr('The bank does not exist or has been deleted.', '题库不存在或已被删除。'));
      setInitial({ name: cleanName, description: description.trim(), subjectId });
      runWithoutPrompt(() => router.replace(`/banks/${id}`));
    } catch (error) {
      NativeAlert.alert(tr('Save failed', '保存失败'), error instanceof Error && error.message.includes('UNIQUE') ? tr('A bank with this name already exists in the same subject.', '同一学科下已存在同名题库。') : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenState pointerEvents={saving ? 'none' : 'auto'}>
        <Stack.Screen options={{ title: pageTitle }} />
        {loadState === 'loading' ? (
          <Surface variant="tertiary">
            <Spinner accessibilityRole="progressbar" accessibilityLabel={tr('Loading bank', '正在读取题库')} />
            <Typography color="muted">{tr('Loading bank', '正在读取题库')}</Typography>
          </Surface>
        ) : null}
        {loadState === 'missing' ? (
          <Card className="gap-3">
            <Card.Title>{tr('Bank not found', '题库不存在')}</Card.Title>
            <Typography color="muted">{tr('The bank may have been deleted.', '题库可能已被删除。')}</Typography>
            <Button onPress={() => router.replace('/banks')}>{tr('Back to banks', '返回题库列表')}</Button>
          </Card>
        ) : null}
        {loadState === 'error' ? (
          <Surface variant="tertiary">
            <Typography.Heading type="h2">{tr('Unable to load bank', '无法读取题库')}</Typography.Heading>
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content><Alert.Title>{loadError || tr('Failed to load bank.', '读取题库失败。')}</Alert.Title></Alert.Content>
            </Alert>
          </Surface>
        ) : null}
        {loadState === 'ready' ? (
          <>
            <TextField isRequired>
              <Label>{tr('Bank name', '题库名称')}</Label>
              <Input
                accessibilityLabel={tr('Bank name', '题库名称')}
                value={name}
                onChangeText={setName}
                placeholder={tr('Example: Grade 8 Algebra', '例如：八年级代数')}
                maxLength={100}
              />
            </TextField>
            <Surface variant="secondary">
              <Typography.Heading type="h2">{tr('Subject', '学科')}</Typography.Heading>
              {subjectLocked ? (
                <>
                  <Chip color="default" variant="soft">{subjects.find((subject) => String(subject.id) === subjectId)?.name ?? tr('Current subject', '当前学科')}</Chip>
                  <Typography color="muted">{tr('The subject is locked after content is added to keep questions, groups, and knowledge points consistent.', '题库加入内容后学科会锁定，以保持试题、题组和知识点一致。')}</Typography>
                </>
              ) : (
                <RadioGroup value={subjectId} onValueChange={setSubjectId}>
                  {subjects.map((subject) => <RadioGroup.Item key={subject.id} value={String(subject.id)}>{subject.name}</RadioGroup.Item>)}
                </RadioGroup>
              )}
            </Surface>
            <TextField>
              <Label>{tr('Description', '说明')}</Label>
              <TextArea
                accessibilityLabel={tr('Description', '说明')}
                value={description}
                onChangeText={setDescription}
                placeholder={tr('Teaching scope, grade level, or usage notes', '教学范围、适用年级或使用说明')}
                maxLength={1000}
              />
            </TextField>
            <Button isDisabled={saving} onPress={() => void save()}>{saving ? tr('Saving…', '保存中…') : tr('Save bank', '保存题库')}</Button>
            <Button variant="ghost" onPress={() => confirmDiscard(() => router.back())}>{tr('Cancel', '取消')}</Button>
          </>
        ) : null}
    </ScreenState>
  );
}
