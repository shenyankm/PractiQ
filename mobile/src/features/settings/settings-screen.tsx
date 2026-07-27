import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Alert as NativeAlert } from 'react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { ListGroup } from 'heroui-native/list-group';
import { Select } from 'heroui-native/select';
import { Separator } from 'heroui-native/separator';
import { Typography } from 'heroui-native/text';

import { ScreenState } from '@/components/screen-state';
import { DATABASE_VERSION } from '@/database/migrations';
import { exportDatabase, restoreDatabase } from '@/files/backup';
import { useLanguage, useLanguageActions } from '@/language';

import { AccountCard } from './account-card';

export default function SettingsPage() {
  const { language, tr } = useLanguage();
  const { languageSaving, setLanguage } = useLanguageActions();
  const [error, setError] = useState('');

  const changeLanguage = async (nextLanguage: 'en' | 'zh-CN') => {
    setError('');
    try {
      await setLanguage(nextLanguage);
    } catch {
      setError(tr('Failed to save the language setting.', '保存语言设置失败。'));
    }
  };

  return (
    <ScreenState>
        <Typography.Heading type="h1">{tr('Settings', '设置')}</Typography.Heading>
        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}

        <Typography.Heading type="h2">{tr('General', '通用')}</Typography.Heading>
        <Card className="flex-row items-center gap-3">
          <Card.Title>{tr('Display language', '显示语言')}</Card.Title>
          <Select
            className="ml-auto w-40"
            value={{ value: language, label: language === 'en' ? 'English' : '简体中文' }}
            isDisabled={languageSaving}
            onValueChange={(option) => {
              if (option) void changeLanguage(option.value as 'en' | 'zh-CN');
            }}
          >
            <Select.Trigger accessibilityLabel={tr('Display language', '显示语言')}>
              <Select.Value placeholder={tr('Select a language', '选择语言')} />
              <Select.TriggerIndicator />
            </Select.Trigger>
            <Select.Portal>
              <Select.Overlay />
              <Select.Content presentation="popover" width="trigger">
                <Select.Item value="en" label="English" />
                <Select.Item value="zh-CN" label="简体中文" />
              </Select.Content>
            </Select.Portal>
          </Select>
        </Card>

        <Typography.Heading type="h2">{tr('Services and data', '服务与数据')}</Typography.Heading>
        <ListGroup>
          <ListGroup.Item accessibilityRole="button" onPress={() => router.push('/settings/ai')}>
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>{tr('Cloud account', '云端账户')}</ListGroup.ItemTitle>
            </ListGroup.ItemContent>
            <ListGroup.ItemSuffix />
          </ListGroup.Item>
          <Separator className="mx-4" />
          <ListGroup.Item accessibilityRole="button" onPress={() => router.push('/settings/data')}>
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>{tr('Local data', '本地数据')}</ListGroup.ItemTitle>
            </ListGroup.ItemContent>
            <ListGroup.ItemSuffix />
          </ListGroup.Item>
          <Separator className="mx-4" />
          <ListGroup.Item accessibilityRole="button" onPress={() => router.push('/privacy')}>
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>{tr('Privacy', '隐私')}</ListGroup.ItemTitle>
            </ListGroup.ItemContent>
            <ListGroup.ItemSuffix />
          </ListGroup.Item>
        </ListGroup>
    </ScreenState>
  );
}

export function AiSettingsPage() {
  const { tr } = useLanguage();
  return (
    <ScreenState>
        <AccountCard tr={tr} />
    </ScreenState>
  );
}

export function DataSettingsPage() {
  const db = useSQLiteContext();
  const { tr } = useLanguage();
  const { languageSaving, reloadLanguage } = useLanguageActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const exportBackup = async () => {
    setBusy(true);
    setError('');
    try {
      await exportDatabase(db);
    } catch {
      setError(tr('Export failed. No backup was created.', '导出失败，未生成备份。'));
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = () => NativeAlert.alert(
    tr('Restore local backup?', '恢复本地备份？'),
    tr('The backup will replace current banks, practice, media, and import sources. Export current data first if needed.', '当前题库、练习、媒体和导入源文件会被备份内容覆盖。恢复前建议先导出当前数据。'),
    [
      { text: tr('Cancel', '取消'), style: 'cancel' },
      {
        text: tr('Choose backup', '选择备份'),
        style: 'destructive',
        onPress: () => void (async () => {
          setBusy(true);
          setError('');
          try {
            const restored = await restoreDatabase(db);
            if (!restored) return;
            let languageWarning = '';
            try {
              await reloadLanguage();
            } catch {
              languageWarning = tr(' The restored language could not be refreshed; restart PractiQ to apply it.', ' 恢复的语言设置暂时无法刷新；请重启 PractiQ 后应用。');
            }
            NativeAlert.alert(
              tr('Restore complete', '恢复完成'),
              restored === 'legacy'
                ? tr(
                  `This legacy database backup does not include media or import sources.${languageWarning}`,
                  `这是旧版数据库备份，不包含媒体和导入源文件；缺失文件无法恢复。${languageWarning}`,
                )
                : tr(
                  `The database, media, and import sources were restored.${languageWarning}`,
                  `数据库、媒体和导入源文件已恢复。${languageWarning}`,
                ),
            );
            router.replace('/');
          } catch {
            setError(tr('Restore failed. Current data was not replaced.', '恢复失败，当前数据未被替换'));
          } finally {
            setBusy(false);
          }
        })(),
      },
    ],
  );

  return (
    <ScreenState>
        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}
        <Card className="gap-3">
          <Card.Title>{tr('Complete local backup', '完整本地备份')}</Card.Title>
          <Button variant="secondary" isDisabled={busy} onPress={() => void exportBackup()}>
            {tr('Export full backup', '导出完整备份')}
          </Button>
          <Button variant="danger" isDisabled={busy || languageSaving} onPress={confirmRestore}>
            {tr('Restore backup', '恢复备份')}
          </Button>
          <Typography color="muted">{tr(`Database format version ${DATABASE_VERSION}`, `数据库格式版本 ${DATABASE_VERSION}`)}</Typography>
        </Card>
    </ScreenState>
  );
}
