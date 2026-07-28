// @vitest-environment jsdom

import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/api';
import { LoginPage, safeRedirect } from '@/pages/LoginPage';

const routerState = vi.hoisted(() => ({
  searchParams: new URLSearchParams()
}));

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn()
}));

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [routerState.searchParams, vi.fn()]
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  apiRequest: mocks.apiRequest
}));

function submitRegistration(password = 'password123', confirmPassword = password) {
  render(<LoginPage mode="signup" />);
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.com' } });
  fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '123456' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: confirmPassword } });
  fireEvent.click(screen.getByRole('button', { name: '注册' }));
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routerState.searchParams = new URLSearchParams();
  });

  it('submits sign-in credentials', async () => {
    routerState.searchParams = new URLSearchParams({
      redirect: '/imports/42?tab=review#latest'
    });
    mocks.apiRequest.mockResolvedValueOnce({ id: 42 });

    render(<LoginPage mode="signin" />);

    fireEvent.change(screen.getByLabelText('用户名或邮箱'), {
      target: { value: 'alice@example.com' }
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'password123' }
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      {
        method: 'POST',
        json: { login: 'alice@example.com', password: 'password123' }
      }
    );
  });

  it('submits registration details', async () => {
    routerState.searchParams = new URLSearchParams({
      redirect: 'https://evil.example/phish'
    });
    mocks.apiRequest.mockResolvedValueOnce({ id: 7 });

    submitRegistration();

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/api/v1/auth/register',
      {
        method: 'POST',
        json: { username: 'alice', email: 'alice@example.com', password: 'password123', code: '123456' }
      }
    );
  });

  it('sends the email verification code and starts a countdown', async () => {
    mocks.apiRequest.mockResolvedValueOnce(undefined);

    render(<LoginPage mode="signup" />);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/api/v1/auth/email-code',
      { method: 'POST', json: { email: 'alice@example.com' } }
    ));
    expect(await screen.findByRole('button', { name: '60 秒后重试' })).toBeDefined();
  });

  it('starts the Google sign-in flow from the login card', () => {
    render(<LoginPage mode="signin" />);

    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    fireEvent.click(screen.getByRole('button', { name: '使用 Google 登录' }));
    vi.unstubAllGlobals();

    expect(assign).toHaveBeenCalledWith('/api/v1/auth/google/start');
  });

  it('does not submit registration when passwords do not match', () => {
    submitRegistration('password123', 'different-password');

    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it('accepts multibyte passwords that meet the byte minimum', async () => {
    mocks.apiRequest.mockResolvedValueOnce({ id: 7 });

    submitRegistration('中中中');

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
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
    mocks.apiRequest.mockRejectedValueOnce(
      new ApiClientError('Invalid request', 422, 'VALIDATION_ERROR', [{ field: 'email', message: '请输入有效的邮箱地址。' }])
    );

    submitRegistration();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('请输入有效的邮箱地址。');
  });

  it('rejects backslash-based external redirects', () => {
    expect(safeRedirect('/\\attacker.example')).toBe('/dashboard');
  });
});
