// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPage from '@/pages/AdminPage';
import AdminUsersPage from '@/pages/AdminUsersPage';
import AdminKnowledgePointsPage from '@/pages/AdminKnowledgePointsPage';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn()
}));

const originalFetch = globalThis.fetch;

type FetchRoute = {
  method?: string;
  pathname: string;
  handler: (url: URL, request: Request | null, init: RequestInit | undefined) => Response | Promise<Response>;
};

function jsonResponse(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

function normalizeRequest(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  const url = input instanceof URL
    ? input
    : typeof input === 'string'
      ? new URL(input, 'http://localhost')
      : new URL(input.url);
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();

  return { method, request, url };
}

async function readJsonBody(request: Request | null, init?: RequestInit) {
  if (request) return request.clone().json();
  return JSON.parse(String(init?.body ?? '{}'));
}

function installFetchMock(routes: FetchRoute[]) {
  mocks.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { method, request, url } = normalizeRequest(input, init);
    const route = routes.find((candidate) => candidate.pathname === url.pathname && (candidate.method ?? 'GET').toUpperCase() === method);

    if (!route) {
      throw new Error(`Unexpected ${method} ${url.pathname}${url.search}`);
    }

    return route.handler(url, request, init);
  });
}

describe('Vite admin pages', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    globalThis.fetch = mocks.fetch as typeof fetch;
    window.history.pushState({}, '', '/admin');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders the admin overview from the browser API and shows admin-only navigation links', async () => {
    installFetchMock([
      {
        pathname: '/api/v1/admin/overview',
        handler: () => jsonResponse({
          data: {
            total_users: 24,
            active_users: 18,
            total_banks: 7,
            total_questions: 91,
            plus_users: 5,
            import_jobs: 4,
            knowledge_points: 31,
            open_review_items: 3
          }
        })
      }
    ]);

    render(<AdminPage />);

    expect(await screen.findByRole('heading', { name: '后台管理' })).toBeTruthy();
    expect(screen.getByText('18/24')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('91')).toBeTruthy();
    expect(screen.getByRole('link', { name: '进入用户管理' }).getAttribute('href')).toBe('/admin/users');
    expect(screen.getByRole('link', { name: '进入知识点管理' }).getAttribute('href')).toBe('/admin/knowledge-points');
    expect(screen.getByRole('link', { name: '查看导入任务' }).getAttribute('href')).toBe('/imports');
    expect(screen.getByRole('link', { name: '用户' }).getAttribute('href')).toBe('/admin/users');
    expect(screen.getByRole('link', { name: '知识点' }).getAttribute('href')).toBe('/admin/knowledge-points');

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(normalizeRequest(mocks.fetch.mock.calls[0][0] as RequestInfo | URL, mocks.fetch.mock.calls[0][1] as RequestInit | undefined).url.pathname).toBe('/api/v1/admin/overview');
  });

  it('loads filtered admin users and patches user status through the browser API', async () => {
    window.history.pushState({}, '', '/admin/users?q=alice&status=inactive&role=user');

    installFetchMock([
      {
        pathname: '/api/v1/admin/users',
        handler: (url) => {
          expect(url.searchParams.get('q')).toBe('alice');
          expect(url.searchParams.get('status')).toBe('inactive');
          expect(url.searchParams.get('role')).toBe('user');

          return jsonResponse({
            data: [
              {
                id: 7,
                username: 'alice',
                email: 'alice@example.test',
                is_active: true,
                role: 'user',
                membership: 'plus',
                bank_count: 3,
                import_job_count: 2,
                practice_session_count: 11
              }
            ]
          });
        }
      },
      {
        method: 'PATCH',
        pathname: '/api/v1/users/7/status',
        handler: async (_url, request, init) => {
          expect(await readJsonBody(request, init)).toEqual({ isActive: false });
          return jsonResponse({
            data: {
              id: 7,
              is_active: false
            }
          });
        }
      }
    ]);

    render(<AdminUsersPage />);

    expect(await screen.findByText('alice')).toBeTruthy();
    expect(screen.getByText('alice@example.test')).toBeTruthy();
    expect(screen.getByRole('link', { name: '返回后台' }).getAttribute('href')).toBe('/admin');
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认停用' }));

    await waitFor(() => {
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
  });

  it('loads knowledge points plus subjects and creates a new knowledge point through the browser API', async () => {
    window.history.pushState({}, '', '/admin/knowledge-points?q=一次函数&subject=math');

    installFetchMock([
      {
        pathname: '/api/v1/subjects',
        handler: () => jsonResponse({
          data: [
            { subject_id: 'math', display_name: '数学' }
          ]
        })
      },
      {
        pathname: '/api/v1/admin/knowledge-points',
        handler: (url) => {
          expect(url.searchParams.get('q')).toBe('一次函数');
          expect(url.searchParams.get('subject')).toBe('math');

          return jsonResponse({
            data: [
              {
                id: 11,
                subject_id: 'math',
                code: 'math.functions.linear',
                display_name: '一次函数',
                parent_id: null
              }
            ]
          });
        }
      },
      {
        method: 'POST',
        pathname: '/api/v1/knowledge-points',
        handler: async (_url, request, init) => {
          expect(await readJsonBody(request, init)).toEqual({
            subjectId: 'math',
            code: 'math.functions.quadratic',
            displayName: '二次函数',
            parentId: null,
            metadata: {}
          });

          return jsonResponse({
            data: {
              id: 12,
              subject_id: 'math',
              code: 'math.functions.quadratic',
              display_name: '二次函数',
              parent_id: null
            }
          }, { status: 201 });
        }
      }
    ]);

    render(<AdminKnowledgePointsPage />);

    expect(await screen.findByText('一次函数')).toBeTruthy();
    expect(screen.getByRole('link', { name: '返回后台' }).getAttribute('href')).toBe('/admin');
    expect(screen.getByRole('link', { name: '用户' }).getAttribute('href')).toBe('/admin/users');

    fireEvent.change(screen.getByLabelText('编码'), { target: { value: 'math.functions.quadratic' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '二次函数' } });
    fireEvent.click(screen.getByRole('button', { name: '创建知识点' }));

    await waitFor(() => {
      expect(mocks.fetch).toHaveBeenCalledTimes(3);
    });
  });
});
