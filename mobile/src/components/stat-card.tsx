import { Card } from 'heroui-native/card';
import { Typography } from 'heroui-native/text';

export function StatCard({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  className?: string;
}) {
  return (
    <Card className={className}>
      <Typography.Heading type="h3">{label}</Typography.Heading>
      <Typography type="h2">{value}</Typography>
      {hint ? <Typography color="muted">{hint}</Typography> : null}
    </Card>
  );
}
