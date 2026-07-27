import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { Typography } from '@heroui/react';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { OpenWookShell } from '@/layout/OpenWookShell';
import LoginPage from '@/pages/LoginPage';
import AdminPage from '@/pages/AdminPage';
import AdminKnowledgePointsPage from '@/pages/AdminKnowledgePointsPage';
import AdminUsersPage from '@/pages/AdminUsersPage';
import DashboardPage from '@/pages/DashboardPage';
import BanksPage from '@/pages/BanksPage';
import NewBankPage from '@/pages/NewBankPage';
import BankDetailPage from '@/pages/BankDetailPage';
import ManageBankPage from '@/pages/ManageBankPage';
import PracticeSetupPage from '@/pages/PracticeSetupPage';
import PracticeSessionPage from '@/pages/PracticeSessionPage';
import ImportsPage from '@/pages/ImportsPage';
import ImportDetailPage from '@/pages/ImportDetailPage';
import QuestionPage from '@/pages/QuestionPage';
import SettingsPage from '@/pages/SettingsPage';

function ProtectedLayout() {
  const user = useAuth();
  const location = useLocation();
  if (user === undefined) return null;
  if (!user) {
    const redirect = location.pathname + location.search + location.hash;
    return <Navigate to={`/sign-in?redirect=${encodeURIComponent(redirect)}`} replace />;
  }
  return <OpenWookShell user={user}><Outlet /></OpenWookShell>;
}

function Page({ title }: { title: string }) {
  return <Typography.Heading level={1}>{title}</Typography.Heading>;
}

function AdminOnly() {
  const user = useAuth();
  if (!user || user.role !== 'admin') return <Page title="Not found page" />;
  return <Outlet />;
}

export function AppRouter() {
  const router = createBrowserRouter([
    { path: '/', element: <Navigate to="/dashboard" replace /> },
    { path: '/pricing', element: <Page title="Pricing page" /> },
    { path: '/sign-in', element: <LoginPage mode="signin" /> },
    { path: '/sign-up', element: <LoginPage mode="signup" /> },
    {
      element: <ProtectedLayout />,
      children: [
        { path: '/dashboard', element: <DashboardPage /> },
        { path: '/banks', element: <BanksPage /> },
        { path: '/banks/new', element: <NewBankPage /> },
        { path: '/banks/:bankId', element: <BankDetailPage /> },
        { path: '/banks/:bankId/manage', element: <ManageBankPage /> },
        { path: '/banks/:bankId/practice', element: <PracticeSetupPage /> },
        { path: '/practice/:sessionId', element: <PracticeSessionPage /> },
        { path: '/imports', element: <ImportsPage /> },
        { path: '/imports/:jobId', element: <ImportDetailPage /> },
        { path: '/questions/:questionId', element: <QuestionPage /> },
        { path: '/settings', element: <SettingsPage /> },
        {
          element: <AdminOnly />,
          children: [
            { path: '/admin', element: <AdminPage /> },
            { path: '/admin/knowledge-points', element: <AdminKnowledgePointsPage /> },
            { path: '/admin/users', element: <AdminUsersPage /> }
          ]
        }
      ]
    },
    { path: '*', element: <Page title="Not found page" /> }
  ]);

  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
