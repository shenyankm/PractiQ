import type { PropsWithChildren } from 'react';
import { Surface } from 'heroui-native/surface';
import { Typography } from 'heroui-native/text';

export function Section({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <Surface className="gap-3 rounded-none p-0" variant="transparent">
      <Typography.Heading type="h2">{title}</Typography.Heading>
      {children}
    </Surface>
  );
}
