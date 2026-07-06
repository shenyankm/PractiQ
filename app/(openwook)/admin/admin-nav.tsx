import { BookOpen, FileWarning, Tags, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent } from '@heroui/react';

const adminLinks = [
  { href: '/admin/users', label: '用户', icon: UsersRound },
  { href: '/admin/knowledge-points', label: '知识点', icon: Tags },
  { href: '/banks', label: '题库', icon: BookOpen },
  { href: '/imports', label: '导入复核', icon: FileWarning }
];

export function AdminNav() {
  return (
    <Card>
      <CardContent className="flex flex-wrap gap-2 p-3">
        {adminLinks.map((item) => (
          <Link key={item.href} href={item.href} className="button button--ghost button--sm">
  <item.icon className="size-4" />
              {item.label}
</Link>
        ))}
      </CardContent>
    </Card>
  );
}
