import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getCurrentUser } from "@/data/auth";

import { Landing } from "./landing";

async function RedirectIfAuthed() {
  const user = await getCurrentUser();
  if (user) redirect("/");
  return null;
}

export default function WelcomePage() {
  return (
    <>
      <Suspense fallback={null}>
        <RedirectIfAuthed />
      </Suspense>
      <Landing />
    </>
  );
}
