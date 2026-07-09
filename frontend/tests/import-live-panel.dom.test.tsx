// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportLivePanel } from '@/pages/imports/ImportLivePanel';

type ImportEventPayload = {
  id: number;
  step_label: string | null;
  step_code: string;
  stage?: string | null;
  status: string;
  message: string | null;
  overall_progress_percent?: number | null;
  step_progress_percent?: number | null;
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly close = vi.fn();
  private readonly listeners = new Map<string, EventListenerOrEventListenerObject[]>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emit(type: string, payload: ImportEventPayload) {
    const message = new MessageEvent('message', {
      data: JSON.stringify(payload)
    });

    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') {
        listener(message);
      } else {
        listener.handleEvent(message);
      }
    }
  }
}

const originalEventSource = globalThis.EventSource;

describe('ImportLivePanel', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
  });

  it('subscribes to the job event stream and renders import-event payloads', async () => {
    const { unmount } = render(
      <ImportLivePanel
        job={{
          id: 42,
          status: 'queued',
          stage: 'queued',
          overall_progress_percent: 0,
          step_progress_percent: 0,
          last_error: null
        }}
        events={[]}
        metrics={{
          pages: 0,
          blocks: 0,
          imported: 0,
          reviewItems: 0
        }}
      />
    );

    expect(screen.getByText('暂无事件。')).toBeTruthy();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe('/api/v1/import-jobs/42/events/stream');

    act(() => {
      FakeEventSource.instances[0]?.emit('import-event', {
        id: 7,
        step_label: '解析完成',
        step_code: 'parse',
        stage: 'parsing',
        status: 'processing',
        message: '收到一条新事件',
        overall_progress_percent: 40,
        step_progress_percent: 80
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('暂无事件。')).toBeNull();
    });

    expect(screen.getByText('解析完成 · processing')).toBeTruthy();
    expect(screen.getByText('收到一条新事件')).toBeTruthy();
    unmount();
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledTimes(1);
  });
});
