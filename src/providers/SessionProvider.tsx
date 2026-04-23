"use client";

import { createContext, useContext, type ReactNode } from "react";

export type SessionUser = { id: string; name: string; email: string };

const SessionContext = createContext<SessionUser | null>(null);

export function SessionProvider({ user, children }: { user: SessionUser; children: ReactNode }) {
  return <SessionContext value={user}>{children}</SessionContext>;
}

export function useSession(): SessionUser {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
