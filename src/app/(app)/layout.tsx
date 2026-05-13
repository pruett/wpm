import { redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { BetConfirmProvider } from "@/components/bet-confirm-provider";
import { getCurrentUser } from "@/data/auth";
import { RealtimeProvider } from "@/providers/realtime";
import { SessionProvider } from "@/providers/session";

export default function AppLayout({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <AuthedShell modal={modal}>{children}</AuthedShell>
    </Suspense>
  );
}

async function AuthedShell({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/welcome");

  return (
    <SessionProvider user={user}>
      <RealtimeProvider>
        <BetConfirmProvider>
          {children}
          {modal}
        </BetConfirmProvider>
      </RealtimeProvider>
    </SessionProvider>
  );
}
