import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { Typography } from '@heroui/react';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { OpenWookShell } from '@/layout/OpenWookShell';
import LoginPage from '@/pages/LoginPage';
import AdminPage from '@/pages/AdminPage';
import AdminKnowledgePointsPage from '@/pages/AdminKnowledgePointsPage';
import AdminUsersPage from '@/pages/AdminUsersPage';

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

function Page({ title }: { title: string }) {
  return <Typography.Heading level={1}>{title}</Typography.Heading>;
}

function AdminOnly() {
  const { user } = useAuth();
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
        { path: '/dashboard', element: <Page title="Dashboard page" /> },
        { path: '/banks', element: <Page title="Banks page" /> },
        { path: '/banks/new', element: <Page title="New bank page" /> },
        { path: '/banks/:bankId', element: <Page title="Bank detail page" /> },
        { path: '/banks/:bankId/manage', element: <Page title="Bank manage page" /> },
        { path: '/banks/:bankId/practice', element: <Page title="Practice setup page" /> },
        { path: '/practice/:sessionId', element: <Page title="Practice session page" /> },
        { path: '/imports', element: <Page title="Imports page" /> },
        { path: '/imports/:jobId', element: <Page title="Import detail page" /> },
        { path: '/questions/:questionId', element: <Page title="Question detail page" /> },
        { path: '/settings', element: <Page title="Settings page" /> },
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
