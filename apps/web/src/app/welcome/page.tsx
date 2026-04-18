import { redirect } from "next/navigation";
import { getCurrentUser } from "@/data/auth";
import { Landing } from "./landing";

export default async function WelcomePage() {
  const user = await getCurrentUser();
  if (user) redirect("/");
  return <Landing />;
}
