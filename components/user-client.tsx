"use client";

import { useState } from "react";
import { UserForm } from "@/components/user-form";
import { UserList } from "@/components/user-list";
import type { User } from "@/lib/types";

export function UserFormWrapper() {
  const handleUserCreated = () => {
    window.location.reload();
  };
  return <UserForm onUserCreated={handleUserCreated} />;
}

export function UserListWrapper({ initialUsers }: { initialUsers: User[] }) {
  const [users, setUsers] = useState<User[]>(initialUsers);
  const handleUserDeleted = (id: number) => {
    setUsers((prev) => prev.filter((u) => u.id !== id));
    window.location.reload();
  };
  return <UserList users={users} onUserDeleted={handleUserDeleted} />;
}
