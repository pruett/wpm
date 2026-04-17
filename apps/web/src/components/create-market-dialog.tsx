"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createMarket } from "@/app/actions/admin/createMarket";

type FormState = {
  id: string;
  sport: string;
  name: string;
  teamA: string;
  teamB: string;
  logoA: string;
  logoB: string;
  leagueLogo: string;
  startTime: string;
  bettingClosesAt: string;
  seedAmount: string;
  initialProbabilityA: string;
};

const EMPTY: FormState = {
  id: "",
  sport: "",
  name: "",
  teamA: "",
  teamB: "",
  logoA: "",
  logoB: "",
  leagueLogo: "",
  startTime: "",
  bettingClosesAt: "",
  seedAmount: "1000",
  initialProbabilityA: "",
};

function localToIso(value: string): string {
  return new Date(value).toISOString();
}

export function CreateMarketDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);

    const seedAmount = Number(form.seedAmount);
    if (!Number.isFinite(seedAmount) || seedAmount <= 0) {
      setMessage({ type: "error", text: "Seed amount must be positive" });
      return;
    }

    let initialProbabilityA: number | undefined;
    if (form.initialProbabilityA.trim() !== "") {
      initialProbabilityA = Number(form.initialProbabilityA);
      if (
        !Number.isFinite(initialProbabilityA) ||
        initialProbabilityA < 0 ||
        initialProbabilityA > 1
      ) {
        setMessage({ type: "error", text: "Probability must be between 0 and 1" });
        return;
      }
    }

    startTransition(async () => {
      const res = await createMarket({
        id: form.id.trim(),
        sport: form.sport.trim(),
        name: form.name.trim(),
        teamA: form.teamA.trim(),
        teamB: form.teamB.trim(),
        logoA: form.logoA.trim() || undefined,
        logoB: form.logoB.trim() || undefined,
        leagueLogo: form.leagueLogo.trim() || undefined,
        startTime: localToIso(form.startTime),
        bettingClosesAt: localToIso(form.bettingClosesAt),
        seedAmount,
        initialProbabilityA,
      });

      if (res.error) {
        setMessage({ type: "error", text: res.error });
        return;
      }
      setMessage({ type: "success", text: "Market created" });
      setForm(EMPTY);
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setMessage(null);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" className="font-mono text-xs uppercase tracking-wider">
            Create market
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-wider">Create market</DialogTitle>
          <DialogDescription>Seed a new prediction market.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Market ID" htmlFor="cm-id">
              <Input
                id="cm-id"
                value={form.id}
                onChange={(e) => update("id", e.target.value)}
                placeholder="nfl-401547439"
                required
                disabled={isPending}
              />
            </Field>
            <Field label="Sport" htmlFor="cm-sport">
              <Input
                id="cm-sport"
                value={form.sport}
                onChange={(e) => update("sport", e.target.value)}
                placeholder="nfl"
                required
                disabled={isPending}
              />
            </Field>
          </div>

          <Field label="Name" htmlFor="cm-name">
            <Input
              id="cm-name"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="Bills vs. Chiefs"
              required
              disabled={isPending}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Team A" htmlFor="cm-teamA">
              <Input
                id="cm-teamA"
                value={form.teamA}
                onChange={(e) => update("teamA", e.target.value)}
                required
                disabled={isPending}
              />
            </Field>
            <Field label="Team B" htmlFor="cm-teamB">
              <Input
                id="cm-teamB"
                value={form.teamB}
                onChange={(e) => update("teamB", e.target.value)}
                required
                disabled={isPending}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts" htmlFor="cm-start">
              <Input
                id="cm-start"
                type="datetime-local"
                value={form.startTime}
                onChange={(e) => update("startTime", e.target.value)}
                required
                disabled={isPending}
              />
            </Field>
            <Field label="Betting closes" htmlFor="cm-close">
              <Input
                id="cm-close"
                type="datetime-local"
                value={form.bettingClosesAt}
                onChange={(e) => update("bettingClosesAt", e.target.value)}
                required
                disabled={isPending}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Seed amount" htmlFor="cm-seed">
              <Input
                id="cm-seed"
                type="number"
                min="1"
                value={form.seedAmount}
                onChange={(e) => update("seedAmount", e.target.value)}
                required
                disabled={isPending}
              />
            </Field>
            <Field label="Initial P(A)" htmlFor="cm-prob" hint="0–1, optional">
              <Input
                id="cm-prob"
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={form.initialProbabilityA}
                onChange={(e) => update("initialProbabilityA", e.target.value)}
                disabled={isPending}
              />
            </Field>
          </div>

          <details className="group">
            <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Logos (optional)
            </summary>
            <div className="mt-3 grid gap-3">
              <Field label="Logo A" htmlFor="cm-logoA">
                <Input
                  id="cm-logoA"
                  value={form.logoA}
                  onChange={(e) => update("logoA", e.target.value)}
                  disabled={isPending}
                />
              </Field>
              <Field label="Logo B" htmlFor="cm-logoB">
                <Input
                  id="cm-logoB"
                  value={form.logoB}
                  onChange={(e) => update("logoB", e.target.value)}
                  disabled={isPending}
                />
              </Field>
              <Field label="League logo" htmlFor="cm-league">
                <Input
                  id="cm-league"
                  value={form.leagueLogo}
                  onChange={(e) => update("leagueLogo", e.target.value)}
                  disabled={isPending}
                />
              </Field>
            </div>
          </details>

          {message && (
            <p
              className={`font-mono text-xs ${
                message.type === "success" ? "text-green-500" : "text-destructive"
              }`}
            >
              {message.text}
            </p>
          )}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" disabled={isPending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="font-mono text-xs uppercase tracking-wider">
        {label}
        {hint && (
          <span className="ml-1 text-muted-foreground normal-case tracking-normal">({hint})</span>
        )}
      </Label>
      {children}
    </div>
  );
}
