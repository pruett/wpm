import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth, isAdmin } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!isAdmin(session)) {
    notFound();
  }

  return <>{children}</>;
}
