import Link from "next/link";
import { Suspense } from "react";

import { LiveTag } from "@/components/live-tag";
import { getBalance } from "@/data/balances";
import { tags } from "@/data/tags";

import { Balance } from "./balance";
import { UserMenu } from "./user-menu";

async function BalanceLoader({ userId }: { userId: string }) {
  const { balance } = await getBalance(userId);
  return (
    <>
      <LiveTag tag={tags.viewer(userId)} />
      <Balance balance={balance} />
    </>
  );
}

export function Header({ user }: { user: { id: string; name: string } }) {
  return (
    <header className="border-b border-border">
      <div className="mx-auto grid h-14 max-w-screen-xl grid-cols-3 items-center px-4">
        <Link href="/" className="font-mono text-lg font-black tracking-[0.15em]">
          WPM
        </Link>
        <nav className="flex items-center justify-center gap-4 font-mono text-sm font-medium tracking-wider uppercase">
          <Link href="/" className="text-muted-foreground hover:text-foreground">
            Home
          </Link>
          <Link href="/bets" className="text-muted-foreground hover:text-foreground">
            Bets
          </Link>
        </nav>
        <div className="flex items-center justify-end gap-4">
          <Suspense fallback={<span className="font-mono text-sm text-muted-foreground">---</span>}>
            <BalanceLoader userId={user.id} />
          </Suspense>
          <UserMenu name={user.name} />
        </div>
      </div>
    </header>
  );
}
