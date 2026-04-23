import Link from "next/link";
import { Suspense } from "react";

import { getBalance } from "@/data/balances";

import { Balance } from "./balance";
import { UserMenu } from "./user-menu";

async function BalanceLoader({ userId }: { userId: string }) {
  const { balance } = await getBalance(userId);
  return <Balance balance={balance} />;
}

export function Header({ user }: { user: { id: string; name: string } }) {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-14 max-w-screen-xl items-center justify-between px-4">
        <Link href="/" className="font-mono text-lg font-black tracking-[0.15em]">
          WPM
        </Link>
        <div className="flex items-center gap-4">
          <Suspense fallback={<span className="font-mono text-sm text-muted-foreground">---</span>}>
            <BalanceLoader userId={user.id} />
          </Suspense>
          <UserMenu name={user.name} />
        </div>
      </div>
    </header>
  );
}
