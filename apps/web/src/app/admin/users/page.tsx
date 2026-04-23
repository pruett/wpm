import { Suspense } from "react";

import { DistributeForm } from "@/components/distribute-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getUsers } from "@/data/users";

function truncate(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

async function UsersTable() {
  const users = await getUsers();

  if (users.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center font-mono text-sm text-muted-foreground">
          No users registered yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          {users.length} registered {users.length === 1 ? "user" : "users"}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-2 text-left font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  #
                </th>
                <th className="px-4 py-2 text-left font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  User
                </th>
                <th className="px-4 py-2 text-right font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  Balance
                </th>
                <th className="px-4 py-2 text-left font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  Distribute
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user, i) => (
                <tr
                  key={user.userId}
                  className="border-b border-border/50 last:border-0 hover:bg-muted/30"
                >
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-4 py-3 font-mono text-sm">
                    {user.name || truncate(user.userId)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">
                    {user.balance.toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <DistributeForm userId={user.userId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminUsersPage() {
  return (
    <div>
      <h1 className="mb-6 font-mono text-2xl font-black tracking-wider uppercase">Users</h1>
      <Suspense
        fallback={
          <Card>
            <CardHeader className="pb-3">
              <div className="h-3 w-32 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse rounded bg-muted" />
              ))}
            </CardContent>
          </Card>
        }
      >
        <UsersTable />
      </Suspense>
    </div>
  );
}
