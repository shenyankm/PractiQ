import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, Separator, Surface, Typography } from '@heroui/react';
import { Banks, BankDetail, QuestionEditor, QuestionDetail, SettingsPage, SearchPage } from './pages-content';
import { Home, PracticeSetup, PracticePage, ResultsPage, Analytics, BankAnalytics } from './pages-practice';
import { Imports, ImportCreate, ImportDetail, TaskPage } from './pages-imports';
import { Go } from './ui';
import './styles.css';

const navigation = [{ path: '/', label: '学习' }, { path: '/banks', label: '题库' }, { path: '/imports', label: '导入' }, { path: '/analytics', label: '分析' }, { path: '/settings', label: '设置' }];
function Navigation() {
  const location = useLocation(), navigate = useNavigate();
  return <>{navigation.map(n => <Button key={n.path} size="sm" variant={(n.path === '/' ? location.pathname === '/' : location.pathname.startsWith(n.path)) ? 'primary' : 'tertiary'} onPress={() => navigate(n.path)}>{n.label}</Button>)}</>;
}
function App() {
  const location = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  return <div className="min-h-dvh md:flex"><aside className="hidden md:block md:w-56 md:shrink-0"><Surface className="sticky top-0 flex h-dvh flex-col gap-6 p-6"><Typography.Heading level={2}>PractiQ</Typography.Heading><Typography.Paragraph className="max-w-full overflow-x-auto">个人学习工作台</Typography.Paragraph><Separator /><nav aria-label="主导航" className="flex flex-col gap-2"><Navigation /></nav><Go to="/search">搜索题目</Go></Surface></aside><div className="min-w-0 flex-1"><main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 pb-28 md:p-8" id="main-content"><Routes><Route path="/" element={<Home />} /><Route path="/banks" element={<Banks />} /><Route path="/banks/:id" element={<BankDetail />} /><Route path="/banks/:id/questions/new" element={<QuestionEditor />} /><Route path="/questions/:id" element={<QuestionDetail />} /><Route path="/questions/:id/edit" element={<QuestionEditor />} /><Route path="/practice/new/:id" element={<PracticeSetup />} /><Route path="/practice/:id" element={<PracticePage />} /><Route path="/practice/:id/results" element={<ResultsPage />} /><Route path="/imports" element={<Imports />} /><Route path="/imports/new" element={<ImportCreate />} /><Route path="/imports/:id" element={<ImportDetail />} /><Route path="/tasks/:id" element={<TaskPage />} /><Route path="/analytics" element={<Analytics />} /><Route path="/analytics/banks/:id" element={<BankAnalytics />} /><Route path="/search" element={<SearchPage />} /><Route path="/settings" element={<SettingsPage />} /><Route path="*" element={<Card><Card.Title>页面不存在</Card.Title><Go to="/">返回学习首页</Go></Card>} /></Routes></main></div><Surface className="fixed inset-x-0 bottom-0 z-20 p-3 pb-6 md:hidden"><nav aria-label="移动导航" className="flex items-center justify-between gap-1"><Navigation /></nav></Surface></div>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>);
