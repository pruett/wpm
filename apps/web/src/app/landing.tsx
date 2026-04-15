import Link from "next/link";
import { Button } from "@/components/ui/button";

export function Landing() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-4">
      <div className="text-center">
        <h1 className="text-5xl font-bold tracking-tight">WPM</h1>
        <p className="mt-2 text-lg text-muted-foreground">Wampum Prediction Markets</p>
      </div>
      <div className="flex gap-4">
        <Button asChild>
          <Link href="/login">Log in</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/register">Create account</Link>
        </Button>
      </div>
    </main>
  );
}
