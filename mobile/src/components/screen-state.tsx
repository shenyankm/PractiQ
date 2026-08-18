import type { ComponentProps, PropsWithChildren } from 'react';
import { ScrollView } from 'react-native';
import { Surface } from 'heroui-native/surface';

type ScrollViewProps = ComponentProps<typeof ScrollView>;

export function ScreenState({
  children,
  className = 'gap-4 rounded-none',
  pointerEvents,
  keyboardShouldPersistTaps = 'handled',
  contentInsetAdjustmentBehavior = 'automatic',
  contentContainerStyle,
}: PropsWithChildren<{
  className?: string;
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  keyboardShouldPersistTaps?: ScrollViewProps['keyboardShouldPersistTaps'];
  contentInsetAdjustmentBehavior?: ScrollViewProps['contentInsetAdjustmentBehavior'];
  contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
}>) {
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior={contentInsetAdjustmentBehavior}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
    >
      <Surface className={className} variant="transparent" pointerEvents={pointerEvents}>{children}</Surface>
    </ScrollView>
  );
}
