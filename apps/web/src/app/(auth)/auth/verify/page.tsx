"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth/client";

type Stage = "verifying" | "passkey-prompt" | "error";

export default function VerifyPage() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const [stage, setStage] = useState<Stage>("verifying");
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stage !== "verifying") return;

    if (session?.user) {
      setStage("passkey-prompt");
      return;
    }

    const timeout = setTimeout(() => {
      if (!session?.user) setStage("error");
    }, 3000);

    return () => clearTimeout(timeout);
  }, [session, stage]);

  async function addPasskey() {
    setEnrolling(true);
    setError(null);
    try {
      const { error: authError } = await authClient.passkey.addPasskey({
        name: "WPM Passkey",
      });
      if (authError) throw new Error(authError.message);
    } catch {
      // Passkey enrollment is optional — swallow errors
    } finally {
      router.push("/");
    }
  }

  function skip() {
    router.push("/");
  }

  if (stage === "verifying") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Verifying…</CardTitle>
          <CardDescription>Completing your sign-in</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (stage === "error") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Verification failed</CardTitle>
          <CardDescription>
            We couldn&apos;t verify your sign-in. The link may have expired.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" onClick={() => router.push("/login")}>
            Back to login
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up a passkey</CardTitle>
        <CardDescription>
          Use Touch ID, Face ID, or your device biometrics for faster sign-in next time.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={addPasskey} disabled={enrolling} className="w-full">
          {enrolling ? "Setting up…" : "Add passkey"}
        </Button>
        <Button variant="ghost" onClick={skip} disabled={enrolling} className="w-full">
          Skip for now
        </Button>
      </CardContent>
    </Card>
  );
}
