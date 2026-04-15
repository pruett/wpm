import { Suspense } from "react";
import { connection } from "next/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getUsers } from "@/lib/data/users";
import { DistributeForm } from "@/components/distribute-form";

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function UsersTable() {
  await connection();
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
        <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          {users.length} registered {users.length === 1 ? "user" : "users"}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-2 text-left font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  #
                </th>
                <th className="px-4 py-2 text-left font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  User ID
                </th>
                <th className="px-4 py-2 text-left font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Address
                </th>
                <th className="px-4 py-2 text-right font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Balance
                </th>
                <th className="px-4 py-2 text-left font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                  <td className="px-4 py-3 font-mono text-xs tabular-nums text-muted-foreground">
                    {i + 1}
                  </td>
                  <td className="px-4 py-3 font-mono text-sm">{truncateAddress(user.userId)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {truncateAddress(user.address)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">
                    {user.balance.toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <DistributeForm userId={user.userId} address={user.address} />
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
      <h1 className="mb-6 font-mono text-2xl font-black uppercase tracking-wider">Users</h1>
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
