'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ImportJob } from '@/lib/openwook/types';

type EventRow = {
  id: number;
  step_label: string | null;
  step_code: string;
  stage?: string | null;
  status: string;
  message: string | null;
  overall_progress_percent?: number | null;
  step_progress_percent?: number | null;
};

type Props = {
  job: ImportJob;
  events: EventRow[];
  metrics: {
    pages: number;
    blocks: number;
    imported: number;
    reviewItems: number;
  };
};

export function ImportLivePanel({ job, events: initialEvents, metrics }: Props) {
  const router = useRouter();
  const [liveJob, setLiveJob] = useState(job);
  const [events, setEvents] = useState(initialEvents);

  useEffect(() => {
    const source = new EventSource(`/api/v1/import-jobs/${job.id}/events/stream`);
    source.addEventListener('import-event', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as EventRow;
      setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
      setLiveJob((current) => ({
        ...current,
        status: event.status === 'completed' || event.status === 'failed' ? event.status as ImportJob['status'] : current.status,
        stage: event.stage || current.stage,
        overall_progress_percent: event.overall_progress_percent ?? current.overall_progress_percent,
        step_progress_percent: event.step_progress_percent ?? current.step_progress_percent
      }));
      if (event.status === 'completed' || event.status === 'failed') {
        window.setTimeout(() => router.refresh(), 600);
      }
    });
    return () => source.close();
  }, [job.id, router]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>进度</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-2 overflow-hidden rounded bg-slate-100">
            <div className="h-full bg-orange-600" style={{ width: `${liveJob.overall_progress_percent ?? 0}%` }} />
          </div>
          <div className="mt-3 grid gap-3 text-sm md:grid-cols-4">
            <Metric label="页数" value={metrics.pages} />
            <Metric label="区块" value={metrics.blocks} />
            <Metric label="已导入" value={metrics.imported} />
            <Metric label="复核项" value={metrics.reviewItems} />
          </div>
          <div className="mt-3 text-sm text-slate-500">{liveJob.status} · {liveJob.stage}</div>
          {liveJob.last_error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{liveJob.last_error}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>事件</CardTitle>
        </CardHeader>
        <CardContent className="max-h-96 space-y-2 overflow-auto">
          {events.length === 0 ? <p className="text-sm text-slate-500">暂无事件。</p> : events.map((event) => (
            <div key={event.id} className="rounded-md border px-3 py-2 text-sm">
              <div className="font-medium">{event.step_label || event.step_code} · {event.status}</div>
              {event.message && <div className="text-slate-500">{event.message}</div>}
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-slate-100 px-3 py-2">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-slate-500">{label}</div>
    </div>
  );
}
