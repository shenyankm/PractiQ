import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColor } from 'heroui-native/hooks';

import { PrimaryTabs } from '@/components/primary-tabs';
import { useLanguage } from '@/language';
import { CONTENT_MAX_WIDTH } from '@/layout';

export const unstable_settings = { initialRouteName: 'index' };

export default function TabLayout() {
  const { tr } = useLanguage();
  const { top, left, right } = useSafeAreaInsets();
  const backgroundColor = useThemeColor('background');

  return (
    <Tabs
      backBehavior="history"
      tabBar={(props) => <PrimaryTabs {...props} />}
      screenOptions={{
        headerShown: false,
        freezeOnBlur: true,
        sceneStyle: {
          alignSelf: 'center',
          backgroundColor,
          maxWidth: CONTENT_MAX_WIDTH,
          paddingTop: top,
          paddingLeft: left,
          paddingRight: right,
          width: '100%',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: tr('Overview', '概览'),
          tabBarAccessibilityLabel: tr('Overview tab', '概览标签页'),
        }}
      />
      <Tabs.Screen
        name="banks"
        options={{
          title: tr('Banks', '题库'),
          tabBarAccessibilityLabel: tr('Question banks tab', '题库标签页'),
        }}
      />
      <Tabs.Screen
        name="analytics"
        options={{
          title: tr('Analytics', '分析'),
          tabBarAccessibilityLabel: tr('Analytics tab', '分析标签页'),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: tr('Settings', '设置'),
          tabBarAccessibilityLabel: tr('Settings tab', '设置标签页'),
        }}
      />
    </Tabs>
  );
}
