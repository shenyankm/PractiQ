import { useEffect, useState } from 'react';
import { Link } from '@heroui/react';
import { apiRequest } from '@/lib/api';

type Overview = {
  total_users: number;
  active_users: number;
  total_banks: number;
  total_questions: number;
  plus_users: number;
  import_jobs: number;
  knowledge_points: number;
  open_review_items: number;
};

export default function AdminPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  useEffect(() => {
    apiRequest<Overview>('/api/v1/admin/overview').then(setOverview).catch(() => setOverview(null));
  }, []);
  return (
    <div>
      <h1>后台管理</h1>
      <nav>
        <Link href="/admin/users">用户</Link>
        <Link href="/admin/knowledge-points">知识点</Link>
      </nav>
      {overview ? (
        <div>
          <div>{overview.active_users}/{overview.total_users}</div>
          <div>{overview.total_banks}</div>
          <div>{overview.total_questions}</div>
          <Link href="/admin/users">进入用户管理</Link>
          <Link href="/admin/knowledge-points">进入知识点管理</Link>
          <Link href="/imports">查看导入任务</Link>
        </div>
      ) : null}
    </div>
  );
}
