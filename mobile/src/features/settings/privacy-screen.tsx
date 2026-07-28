import { Stack } from 'expo-router';
import { Card } from 'heroui-native/card';
import { Typography } from 'heroui-native/text';

import { ScreenState } from '@/components/screen-state';
import { useLanguage } from '@/language';

export default function PrivacyPage() {
  const { tr } = useLanguage();
  return (
    <ScreenState>
      <Stack.Screen options={{ title: tr('Privacy Policy', '隐私政策') }} />
      <Typography color="muted">{tr('Effective date: July 27, 2026', '生效日期：2026 年 7 月 27 日')}</Typography>
      <Card className="gap-3">
        <Card.Title>{tr('Cloud data', '云端数据')}</Card.Title>
        <Typography>{tr(
          'Your PractiQ account, banks, questions, imports, practice answers, and learning statistics are stored by the PractiQ service. PostgreSQL is the authoritative copy so the same data is available on mobile and Web.',
          '你的 PractiQ 账号、题库、试题、导入任务、练习答案和学习统计由 PractiQ 服务保存。PostgreSQL 是权威副本，因此移动端和 Web 端可以访问同一份数据。',
        )}</Typography>
      </Card>
      <Card className="gap-3">
        <Card.Title>{tr('Data on this device', '设备内数据')}</Card.Title>
        <Typography>{tr(
          'PractiQ caches recently viewed server data and pending offline changes in an app-private SQLite database. Import files waiting for upload are kept in the app sandbox. These local copies are cleared when you sign out or remove the app.',
          'PractiQ 会在应用私有 SQLite 数据库中缓存最近查看的云端数据和待同步离线修改；等待上传的导入文件保存在应用沙盒中。退出登录或移除应用时会清除这些本地副本。',
        )}</Typography>
        <Typography>{tr(
          'Existing data from the former local-first PractiQ app is not uploaded automatically.',
          '旧版“本地优先”PractiQ 中已有的数据不会被自动上传。',
        )}</Typography>
      </Card>
      <Card className="gap-3">
        <Card.Title>{tr('Credentials and network', '凭证与网络')}</Card.Title>
        <Typography>{tr(
          'The session token is stored only in the platform secure store, never in SQLite, backups, app configuration, or logs. Production traffic uses HTTPS.',
          '会话令牌只保存在平台安全存储中，不写入 SQLite、备份、应用配置或日志；生产环境网络传输使用 HTTPS。',
        )}</Typography>
      </Card>
      <Card className="gap-3">
        <Card.Title>{tr('Tracking and control', '跟踪与控制')}</Card.Title>
        <Typography>{tr(
          'PractiQ contains no advertising or third-party analytics SDK. You can sign out to remove the local token and cache; server-side deletion requests are handled through the PractiQ service operator.',
          'PractiQ 不包含广告或第三方分析 SDK。你可以退出登录以移除本地令牌和缓存；云端数据删除请求由 PractiQ 服务运营方处理。',
        )}</Typography>
      </Card>
    </ScreenState>
  );
}
