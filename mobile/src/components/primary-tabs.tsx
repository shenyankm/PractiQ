import { Tabs as RouterTabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { useThemeColor } from 'heroui-native/hooks';
import { Surface } from 'heroui-native/surface';
import { Tabs } from 'heroui-native/tabs';
import { Typography } from 'heroui-native/text';
import { ChartNoAxesColumnIncreasing, House, LibraryBig, Settings } from 'lucide-react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { TAB_BAR_MAX_WIDTH } from '@/layout';

type PrimaryTab = 'index' | 'banks' | 'analytics' | 'settings';
type PrimaryTabsProps = Parameters<NonNullable<ComponentProps<typeof RouterTabs>['tabBar']>>[0];

const tabIcons = {
  index: House,
  banks: LibraryBig,
  analytics: ChartNoAxesColumnIncreasing,
  settings: Settings,
};

function isPrimaryTab(value: string): value is PrimaryTab {
  return value === 'index' || value === 'banks' || value === 'analytics' || value === 'settings';
}

export function PrimaryTabs({ state, descriptors, navigation, insets }: PrimaryTabsProps) {
  const [selectedColor, mutedColor] = useThemeColor(['segment-foreground', 'muted']);
  const reducedMotion = useReducedMotion();
  const routes = state.routes.filter((route) => isPrimaryTab(route.name));
  const selectedRoute = state.routes[state.index];

  return (
    <Tabs
      className="w-full px-2 pt-2"
      style={{
        alignSelf: 'center',
        maxWidth: TAB_BAR_MAX_WIDTH,
        paddingBottom: Math.max(insets.bottom, 8),
        paddingLeft: Math.max(insets.left, 8),
        paddingRight: Math.max(insets.right, 8),
      }}
      value={selectedRoute?.name}
      onValueChange={(name) => {
        const route = routes.find((item) => item.name === name);
        if (!route) return;
        const event = navigation.emit({
          type: 'tabPress',
          target: route.key,
          canPreventDefault: true,
        });
        if (!event.defaultPrevented && route.key !== selectedRoute?.key) {
          navigation.navigate(route.name, route.params);
        }
      }}
    >
      <Tabs.List className="w-full self-stretch">
        <Tabs.Indicator animation={reducedMotion ? 'disabled' : undefined} />
        {routes.map((route) => {
          const tab = route.name as PrimaryTab;
          const focused = route.key === selectedRoute?.key;
          const options = descriptors[route.key]?.options;
          const label = options?.title ?? tab;
          const TabIcon = tabIcons[tab];
          return (
          <Tabs.Trigger
            accessibilityLabel={options?.tabBarAccessibilityLabel ?? label}
            accessibilityState={{ selected: focused }}
            className="min-h-14 flex-1 py-2"
            key={route.key}
            value={tab}
            onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
          >
            {({ isSelected }) => (
              <Surface className="items-center gap-1 rounded-none bg-transparent p-0" variant="transparent">
                <TabIcon accessible={false} color={isSelected ? selectedColor : mutedColor} size={22} />
                <Typography type="body-sm" style={{ color: isSelected ? selectedColor : mutedColor }}>
                  {label}
                </Typography>
              </Surface>
            )}
          </Tabs.Trigger>
          );
        })}
      </Tabs.List>
    </Tabs>
  );
}
