"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
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

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const { error: authError } = await authClient.signIn.magicLink({
        email: email.trim(),
        name: name.trim(),
        callbackURL: "/auth/verify",
      });
      if (authError) throw new Error(authError.message);
      setMagicLinkSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Enter your details to get started with WPM</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {magicLinkSent ? (
          <p className="text-sm text-muted-foreground">
            Check your email — we sent a login link to{" "}
            <span className="font-medium text-foreground">{email}</span>.
          </p>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <Input
                type="text"
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                required
              />
              <Input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                required
              />
              <Button type="submit" disabled={submitting || !name.trim() || !email.trim()}>
                {submitting ? "Sending..." : "Sign up with magic link"}
              </Button>
            </form>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}
      </CardContent>
      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="text-foreground underline">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
