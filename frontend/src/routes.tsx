import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { OpenWookShell } from '@/layout/OpenWookShell';
import PricingPage from '@/pages/PricingPage';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import BanksPage from '@/pages/BanksPage';
import NewBankPage from '@/pages/NewBankPage';
import BankDetailPage from '@/pages/BankDetailPage';
import BankManagePage from '@/pages/BankManagePage';
import PracticeSetupPage from '@/pages/PracticeSetupPage';
import PracticeSessionPage from '@/pages/PracticeSessionPage';
import ImportsPage from '@/pages/ImportsPage';
import ImportDetailPage from '@/pages/ImportDetailPage';
import QuestionDetailPage from '@/pages/QuestionDetailPage';
import SettingsPage from '@/pages/SettingsPage';
import AdminPage from '@/pages/AdminPage';
import AdminKnowledgePointsPage from '@/pages/AdminKnowledgePointsPage';
import AdminUsersPage from '@/pages/AdminUsersPage';
import NotFoundPage from '@/pages/NotFoundPage';

function ProtectedLayout() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const location = useLocation();
  if (isLoading) return null;
  if (!isAuthenticated || !user) {
    const redirect = location.pathname + location.search + location.hash;
    return <Navigate to={`/sign-in?redirect=${encodeURIComponent(redirect)}`} replace />;
  }
  return <OpenWookShell user={user}><Outlet /></OpenWookShell>;
}

function AdminOnly() {
  const { user } = useAuth();
  if (!user || user.role !== 'admin') return <NotFoundPage />;
  return <Outlet />;
}

export function AppRouter() {
  const router = createBrowserRouter([
    { path: '/', element: <Navigate to="/dashboard" replace /> },
    { path: '/pricing', element: <PricingPage /> },
    { path: '/sign-in', element: <LoginPage mode="signin" /> },
    { path: '/sign-up', element: <LoginPage mode="signup" /> },
    {
      element: <ProtectedLayout />,
      children: [
        { path: '/dashboard', element: <DashboardPage /> },
        { path: '/banks', element: <BanksPage /> },
        { path: '/banks/new', element: <NewBankPage /> },
        { path: '/banks/:bankId', element: <BankDetailPage /> },
        { path: '/banks/:bankId/manage', element: <BankManagePage /> },
        { path: '/banks/:bankId/practice', element: <PracticeSetupPage /> },
        { path: '/practice/:sessionId', element: <PracticeSessionPage /> },
        { path: '/imports', element: <ImportsPage /> },
        { path: '/imports/:jobId', element: <ImportDetailPage /> },
        { path: '/questions/:questionId', element: <QuestionDetailPage /> },
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
    { path: '*', element: <NotFoundPage /> }
  ]);

  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
