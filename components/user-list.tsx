"use client";

import { useState } from "react";
import type { User, ApiResponse } from "@/lib/types";

interface UserListProps {
  users: User[];
  onUserDeleted: (id: number) => void;
}

export function UserList({ users, onUserDeleted }: UserListProps) {
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      const response = await fetch(`/api/users/${id}`, {
        method: "DELETE",
      });

      const result: ApiResponse<null> = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Failed to delete user");
      }

      onUserDeleted(id);
    } catch (error) {
      console.error("Delete error:", error);
    } finally {
      setDeletingId(null);
    }
  };

  if (users.length === 0) {
    return (
      <p className="text-muted-foreground">No users found. Create one above!</p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="min-w-full divide-y divide-border">
        <thead className="bg-muted">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
              ID
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Name
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Email
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Created
            </th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-background">
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-muted/50">
              <td className="px-4 py-3 text-sm text-foreground">{user.id}</td>
              <td className="px-4 py-3 text-sm font-medium text-foreground">
                {user.name}
              </td>
              <td className="px-4 py-3 text-sm text-muted-foreground">
                {user.email}
              </td>
              <td className="px-4 py-3 text-sm text-muted-foreground">
                {new Date(user.created_at).toLocaleDateString()}
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  onClick={() => handleDelete(user.id)}
                  disabled={deletingId === user.id}
                  className="inline-flex items-center rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
                >
                  {deletingId === user.id ? "Deleting..." : "Delete"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
