import { Card } from 'heroui-native/card';
import { Surface } from 'heroui-native/surface';
import { Typography } from 'heroui-native/text';

import { formatDay, formatPercent } from '@/i18n';
import { useLanguage } from '@/language';

export interface ActivityTrendRow {
  day: string;
  answers: number;
  graded: number;
  correct: number;
}

export function ActivityTrend({ rows }: { rows: ActivityTrendRow[] }) {
  const { language, tr } = useLanguage();
  if (!rows.length) return null;

  const maxAnswers = Math.max(1, ...rows.map((row) => row.answers));
  const answers = rows.reduce((total, row) => total + row.answers, 0);
  const graded = rows.reduce((total, row) => total + row.graded, 0);
  const correct = rows.reduce((total, row) => total + row.correct, 0);
  const dayLabel = (day: string) => formatDay(day, language);

  return (
    <Card accessible={false}>
      <Surface className="h-28 flex-row items-end gap-1 rounded-xl p-3" variant="secondary">
        {rows.map((row) => (
          <Surface
            accessible
            accessibilityRole="image"
            accessibilityLabel={tr(
              `${dayLabel(row.day)}, ${row.answers} answers, ${row.graded ? `accuracy ${formatPercent(row.correct / row.graded, language)}` : 'no graded answers'}`,
              `${dayLabel(row.day)}，${row.answers} 次作答，${row.graded ? `正确率 ${formatPercent(row.correct / row.graded, language)}` : '暂无已判分答案'}`,
            )}
            className="flex-1 justify-end rounded-none p-0"
            key={row.day}
            variant="transparent"
          >
            <Surface
              className={row.answers ? 'w-full rounded-t-sm bg-accent p-0' : 'w-full rounded-full bg-separator p-0'}
              style={{ height: row.answers ? Math.max(10, Math.round(row.answers / maxAnswers * 80)) : 3 }}
              variant="transparent"
            />
          </Surface>
        ))}
      </Surface>
      <Surface className="flex-row justify-between rounded-none p-0" variant="transparent">
        <Typography color="muted">{dayLabel(rows[0].day)}</Typography>
        <Typography color="muted">{dayLabel(rows.at(-1)?.day ?? rows[0].day)}</Typography>
      </Surface>
      <Typography color="muted">
        {tr(
          `${answers} answers · ${graded ? `${formatPercent(correct / graded, language)} accuracy` : 'no graded answers'}`,
          `${answers} 次作答 · ${graded ? `正确率 ${formatPercent(correct / graded, language)}` : '暂无已判分答案'}`,
        )}
      </Typography>
    </Card>
  );
}
