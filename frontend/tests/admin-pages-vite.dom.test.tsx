// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPage from '@/pages/AdminPage';
import AdminUsersPage from '@/pages/AdminUsersPage';
import AdminKnowledgePointsPage from '@/pages/AdminKnowledgePointsPage';

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn()
}));

vi.mock('@/lib/api', () => ({ apiRequest: mocks.apiRequest }));

describe('Vite admin pages', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.pushState({}, '', '/admin');
  });

  it('renders the admin overview and shows admin-only navigation links', async () => {
    mocks.apiRequest.mockResolvedValueOnce({
      total_users: 24,
      active_users: 18,
      total_banks: 7,
      total_questions: 91
    });

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

    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/v1/admin/overview');
  });

  it('loads filtered admin users and patches user status', async () => {
    window.history.pushState({}, '', '/admin/users?q=alice&status=inactive&role=user');

    mocks.apiRequest
      .mockResolvedValueOnce([{ id: 7, username: 'alice', email: 'alice@example.test' }])
      .mockResolvedValueOnce({ id: 7 });

    render(<AdminUsersPage />);

    expect(await screen.findByText('alice')).toBeTruthy();
    expect(screen.getByText('alice@example.test')).toBeTruthy();
    expect(screen.getByRole('link', { name: '返回后台' }).getAttribute('href')).toBe('/admin');
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(1, '/api/v1/admin/users?q=alice&status=inactive&role=user');

    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认停用' }));

    await waitFor(() => {
      expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
    });
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(2, '/api/v1/users/7/status', {
      method: 'PATCH',
      json: { isActive: false }
    });
  });

  it('loads subjects and knowledge points, then creates a knowledge point', async () => {
    window.history.pushState({}, '', '/admin/knowledge-points?q=一次函数&subject=math');

    mocks.apiRequest
      .mockResolvedValueOnce([{ subject_id: 'math', display_name: '数学' }])
      .mockResolvedValueOnce([{ id: 11, display_name: '一次函数' }])
      .mockResolvedValueOnce({ id: 12 });

    render(<AdminKnowledgePointsPage />);

    expect(await screen.findByText('一次函数')).toBeTruthy();
    expect(screen.getByRole('link', { name: '返回后台' }).getAttribute('href')).toBe('/admin');
    expect(screen.getByRole('link', { name: '用户' }).getAttribute('href')).toBe('/admin/users');
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(1, '/api/v1/subjects');
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(2, '/api/v1/admin/knowledge-points?q=%E4%B8%80%E6%AC%A1%E5%87%BD%E6%95%B0&subject=math');

    fireEvent.change(screen.getByLabelText('编码'), { target: { value: 'math.functions.quadratic' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '二次函数' } });
    fireEvent.click(screen.getByRole('button', { name: '创建知识点' }));

    await waitFor(() => {
      expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
    });
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(3, '/api/v1/knowledge-points', {
      method: 'POST',
      json: {
        subjectId: 'math',
        code: 'math.functions.quadratic',
        displayName: '二次函数',
        parentId: null,
        metadata: {}
      }
    });
  });
});
