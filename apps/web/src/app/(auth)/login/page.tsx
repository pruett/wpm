"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  async function handlePasskey() {
    setError(null);
    setSubmitting(true);
    try {
      const { error: authError } = await authClient.signIn.passkey();
      if (authError) throw new Error(authError.message);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey sign in failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const { error: authError } = await authClient.signIn.magicLink({
        email: email.trim(),
        callbackURL: "/auth/verify",
      });
      if (authError) throw new Error(authError.message);
      setMagicLinkSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send magic link");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to your WPM account</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {magicLinkSent ? (
          <p className="text-sm text-muted-foreground">
            Check your email — we sent a login link to{" "}
            <span className="font-medium text-foreground">{email}</span>.
          </p>
        ) : (
          <>
            <Button onClick={handlePasskey} disabled={submitting} className="w-full">
              Sign in with passkey
            </Button>

            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">or</span>
              <Separator className="flex-1" />
            </div>

            <form onSubmit={handleMagicLink} className="flex flex-col gap-3">
              <Input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                required
              />
              <Button type="submit" variant="outline" disabled={submitting || !email.trim()}>
                {submitting ? "Sending..." : "Send magic link"}
              </Button>
            </form>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}
      </CardContent>
      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="text-foreground underline">
            Sign up
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
