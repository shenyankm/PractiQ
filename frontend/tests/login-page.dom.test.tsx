// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage, safeRedirect } from '@/pages/LoginPage';

const routerState = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  pathname: '/sign-in'
}));

const fetchMock = vi.hoisted(() => vi.fn());
const originalFetch = globalThis.fetch;

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({
    pathname: routerState.pathname,
    search: routerState.searchParams.toString() ? `?${routerState.searchParams.toString()}` : '',
    hash: ''
  }),
  useSearchParams: () => [routerState.searchParams, vi.fn()]
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('LoginPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    routerState.pathname = '/sign-in';
    routerState.searchParams = new URLSearchParams();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts JSON sign-in credentials after success', async () => {
    routerState.searchParams = new URLSearchParams({
      redirect: '/imports/42?tab=review#latest'
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { user: { id: 42 } } }));

    render(<LoginPage mode="signin" />);

    fireEvent.change(screen.getByLabelText('用户名或邮箱'), {
      target: { value: 'alice@example.com' }
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'password123' }
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST'
      })
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      login: 'alice@example.com',
      password: 'password123'
    });
  });

  it('posts JSON registration payload after success', async () => {
    routerState.pathname = '/sign-up';
    routerState.searchParams = new URLSearchParams({
      redirect: 'https://evil.example/phish'
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }, 201));

    render(<LoginPage mode="signup" />);

    fireEvent.change(screen.getByLabelText('用户名'), {
      target: { value: 'alice' }
    });
    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: 'alice@example.com' }
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'password123' }
    });
    fireEvent.change(screen.getByLabelText('确认密码'), {
      target: { value: 'password123' }
    });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/register',
      expect.objectContaining({
        method: 'POST'
      })
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      username: 'alice',
      email: 'alice@example.com',
      password: 'password123'
    });
  });

  it('does not submit registration when passwords do not match', async () => {
    render(<LoginPage mode="signup" />);

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'different-password' } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it('accepts multibyte passwords that meet the byte minimum', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }, 201));

    render(<LoginPage mode="signup" />);

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: '中中中' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: '中中中' } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('keeps password focus after toggling visibility', () => {
    render(<LoginPage mode="signin" />);

    const passwordInput = screen.getByLabelText('密码');
    const toggle = screen.getByRole('button', { name: '显示密码' });
    act(() => {
      passwordInput.focus();
      fireEvent.pointerDown(toggle);
      fireEvent.click(toggle);
    });

    expect(document.activeElement).toBe(passwordInput);
    expect(passwordInput.getAttribute('type')).toBe('text');
  });

  it('shows backend validation errors', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: [{ field: 'email', message: '请输入有效的邮箱地址。' }]
        }
      }, 422)
    );

    render(<LoginPage mode="signup" />);

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('请输入有效的邮箱地址。');
  });

  it('rejects backslash-based external redirects', () => {
    expect(safeRedirect('/\\attacker.example')).toBe('/dashboard');
  });
});
