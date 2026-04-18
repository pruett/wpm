import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getSession, isAdmin } from "@/data/auth";
import { AdminNav } from "@/components/admin-nav";

async function AdminGate({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!isAdmin(session)) notFound();
  return <>{children}</>;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-screen-xl items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-mono text-lg font-black tracking-[0.15em]">
              WPM
            </Link>
            <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Admin
            </span>
          </div>
          <Link
            href="/"
            className="font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Back to app
          </Link>
        </div>
      </header>
      <div className="mx-auto flex max-w-screen-xl gap-6 px-4 py-6">
        <aside className="hidden w-48 shrink-0 md:block">
          <AdminNav />
        </aside>
        <main className="min-w-0 flex-1">
          <Suspense fallback={null}>
            <AdminGate>{children}</AdminGate>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
