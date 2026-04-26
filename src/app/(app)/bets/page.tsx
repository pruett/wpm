import { Suspense } from "react";

import { Header } from "@/components/header";
import { Portfolio } from "@/components/portfolio";
import { getSession } from "@/data/auth";

export default function BetsPage() {
  return (
    <Suspense fallback={null}>
      <BetsContent />
    </Suspense>
  );
}

async function BetsContent() {
  const session = await getSession();
  if (!session) return null;

  return (
    <>
      <Header user={{ id: session.user.id, name: session.user.name }} />
      <main className="mx-auto max-w-screen-xl px-4 py-6">
        <Suspense>
          <Portfolio userId={session.user.id} />
        </Suspense>
      </main>
    </>
  );
}
