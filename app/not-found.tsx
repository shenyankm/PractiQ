import Link from 'next/link';
import { CircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[radial-gradient(circle_at_top,rgb(0_0_0_/_0.06),transparent_28rem),var(--background)] p-4 dark:bg-[radial-gradient(circle_at_top,rgb(255_255_255_/_0.08),transparent_28rem),var(--background)]">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-6 p-6 text-center">
        <div className="flex justify-center">
          <CircleIcon className="size-12 text-foreground" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight">
          Page Not Found
        </h1>
        <p className="text-base text-muted-foreground">
          The page you are looking for might have been removed, had its name
          changed, or is temporarily unavailable.
        </p>
        <Button asChild variant="outline">
          <Link href="/">Back to Home</Link>
        </Button>
        </CardContent>
      </Card>
    </div>
  );
}
