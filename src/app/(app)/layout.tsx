import { redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { BetConfirmProvider } from "@/components/bet-confirm-provider";
import { getCurrentUser } from "@/data/auth";
import { SessionProvider } from "@/providers/SessionProvider";

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
    <SessionProvider user={{ id: user.id, name: user.name, email: user.email }}>
      <BetConfirmProvider>
        {children}
        {modal}
      </BetConfirmProvider>
    </SessionProvider>
  );
}
