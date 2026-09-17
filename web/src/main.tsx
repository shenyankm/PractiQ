import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Card } from '@heroui/react';
import { Banks, BankDetail, QuestionEditor, QuestionDetail, SettingsPage, SearchPage } from './pages-content';
import { Home, PracticeSetup, PracticePage, ResultsPage, Analytics, BankAnalytics } from './pages-practice';
import { Imports, ImportCreate, ImportDetail, TaskPage } from './pages-imports';
import { Go } from './ui';
import { Sidebar } from './sidebar';
import './styles.css';

function App() {
  const location = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  return <div className="min-h-dvh md:flex"><Sidebar /><div className="min-w-0 flex-1"><main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-8" id="main-content"><Routes><Route path="/" element={<Home />} /><Route path="/banks" element={<Banks />} /><Route path="/banks/:id" element={<BankDetail />} /><Route path="/banks/:id/questions/new" element={<QuestionEditor />} /><Route path="/questions/:id" element={<QuestionDetail />} /><Route path="/questions/:id/edit" element={<QuestionEditor />} /><Route path="/practice/new/:id" element={<PracticeSetup />} /><Route path="/practice/:id" element={<PracticePage />} /><Route path="/practice/:id/results" element={<ResultsPage />} /><Route path="/imports" element={<Imports />} /><Route path="/imports/new" element={<ImportCreate />} /><Route path="/imports/:id" element={<ImportDetail />} /><Route path="/tasks/:id" element={<TaskPage />} /><Route path="/analytics" element={<Analytics />} /><Route path="/analytics/banks/:id" element={<BankAnalytics />} /><Route path="/search" element={<SearchPage />} /><Route path="/settings" element={<SettingsPage />} /><Route path="*" element={<Card><Card.Title>页面不存在</Card.Title><Go to="/">返回学习首页</Go></Card>} /></Routes></main></div></div>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>);
