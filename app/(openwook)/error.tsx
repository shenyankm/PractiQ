'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@heroui/react';


export default function OpenWookError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="size-5 text-destructive" />
          页面加载失败
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {error.message || '请稍后重试，或返回上一页。'}
        </p>
        <Button type="button" className="w-fit" onClick={reset}>
          <RotateCcw className="size-4" />
          重新加载
        </Button>
      </CardContent>
    </Card>
  );
}
