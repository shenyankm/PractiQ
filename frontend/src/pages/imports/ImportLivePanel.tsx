import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, ProgressBar } from '@heroui/react';

type ImportEvent = {
  id: number;
  step_label: string | null;
  step_code: string;
  stage?: string | null;
  status: string;
  message: string | null;
  overall_progress_percent?: number | null;
  step_progress_percent?: number | null;
};

type ImportJob = {
  id: number;
  status: string;
  stage: string;
  overall_progress_percent: number | null;
  step_progress_percent: number | null;
  last_error: string | null;
};

export function ImportLivePanel({ job, events: initialEvents, metrics }: { job: ImportJob; events: ImportEvent[]; metrics: { pages: number; blocks: number; imported: number; reviewItems: number } }) {
  const [events, setEvents] = useState(initialEvents);
  const [liveJob, setLiveJob] = useState(job);

  useEffect(() => {
    const source = new EventSource(`/api/v1/import-jobs/${job.id}/events/stream`);
    source.addEventListener('import-event', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as ImportEvent;
      setEvents((current) => [...current, event].slice(-100));
      setLiveJob((current) => ({
        ...current,
        status: event.status || current.status,
        stage: event.stage || current.stage,
        overall_progress_percent: event.overall_progress_percent ?? current.overall_progress_percent,
        step_progress_percent: event.step_progress_percent ?? current.step_progress_percent
      }));
    });
    return () => source.close();
  }, [job.id]);

  return (
    <div>
      <Card>
        <CardHeader><CardTitle>进度</CardTitle></CardHeader>
        <CardContent>
          <ProgressBar aria-label="导入进度" value={liveJob.overall_progress_percent ?? 0} />
          <div>{metrics.pages}/{metrics.blocks}/{metrics.imported}/{metrics.reviewItems}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>事件</CardTitle></CardHeader>
        <CardContent>
          {events.length === 0 ? <p>暂无事件。</p> : events.map((event) => (
            <div key={event.id}>
              <div>{event.step_label || event.step_code} · {event.status}</div>
              {event.message ? <div>{event.message}</div> : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export default ImportLivePanel;
