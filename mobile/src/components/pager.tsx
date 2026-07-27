import { Button } from 'heroui-native/button';
import { Surface } from 'heroui-native/surface';
import { Typography } from 'heroui-native/text';

import { useLanguage } from '@/language';

export function Pager({
  page,
  hasNext,
  label,
  onPageChange,
  buttonVariant,
  surfaceVariant,
  muted = false,
}: {
  page: number;
  hasNext: boolean;
  label: string;
  onPageChange: (page: number) => void;
  buttonVariant?: 'ghost';
  surfaceVariant?: 'tertiary';
  muted?: boolean;
}) {
  const { tr } = useLanguage();
  return (
    <Surface className="gap-3" variant={surfaceVariant}>
      <Button variant={buttonVariant} isDisabled={!page} onPress={() => onPageChange(Math.max(0, page - 1))}>
        {tr('Previous', '上一页')}
      </Button>
      <Typography color={muted ? 'muted' : undefined}>{label}</Typography>
      <Button variant={buttonVariant} isDisabled={!hasNext} onPress={() => onPageChange(page + 1)}>
        {tr('Next', '下一页')}
      </Button>
    </Surface>
  );
}
