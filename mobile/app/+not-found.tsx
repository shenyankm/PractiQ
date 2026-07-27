import { router } from 'expo-router';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Typography } from 'heroui-native/text';

import { ScreenState } from '@/components/screen-state';
import { useLanguage } from '@/language';

export default function NotFound() {
  const { tr } = useLanguage();
  return (
    <ScreenState>
        <Typography.Heading type="h1">{tr('Page not found', '页面不存在')}</Typography.Heading>
        <Card className="gap-3">
          <Typography.Heading type="h2">{tr('We couldn\'t find this page', '找不到这个页面')}</Typography.Heading>
          <Button onPress={() => router.replace('/')}>{tr('Back to overview', '返回概览')}</Button>
        </Card>
    </ScreenState>
  );
}
