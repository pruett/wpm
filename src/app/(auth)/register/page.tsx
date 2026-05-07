"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Brain,
  Crown,
  Dices,
  Flame,
  Gem,
  type LucideIcon,
  Rocket,
  Skull,
  Target,
  Trophy,
  Shuffle,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { PROFILE_COLOR_HEX, PROFILE_COLORS } from "@/lib/profile";
import { cn } from "@/lib/utils";

const ICONS = [
  "crown",
  "trophy",
  "target",
  "dices",
  "rocket",
  "flame",
  "zap",
  "gem",
  "skull",
  "brain",
] as const;
type IconId = (typeof ICONS)[number];
const ICON_COMPONENTS: Record<IconId, LucideIcon> = {
  crown: Crown,
  trophy: Trophy,
  target: Target,
  dices: Dices,
  rocket: Rocket,
  flame: Flame,
  zap: Zap,
  gem: Gem,
  skull: Skull,
  brain: Brain,
};

const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  displayName: z
    .string()
    .trim()
    .min(2, "Display name must be at least 2 characters")
    .max(20, "Display name must be at most 20 characters")
    .regex(/^[a-zA-Z0-9_-]+$/, "Letters, numbers, dashes, and underscores only"),
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
  color: z.enum(PROFILE_COLORS, { message: "Pick a color" }),
  icon: z.enum(ICONS, { message: "Pick an icon" }),
});

type RegisterFormValues = z.infer<typeof registerSchema>;

export default function RegisterPage() {
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState("");

  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: "",
      displayName: "",
      email: "",
      color: PROFILE_COLORS[0],
      icon: ICONS[0],
    },
    mode: "onBlur",
  });

  useEffect(() => {
    form.setValue("color", PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)]);
    form.setValue("icon", ICONS[Math.floor(Math.random() * ICONS.length)]);
  }, [form]);

  async function onSubmit(values: RegisterFormValues) {
    form.clearErrors("root");
    const { error: authError } = await authClient.signIn.magicLink({
      email: values.email,
      name: values.name,
      callbackURL: "/auth/verify",
      fetchOptions: {
        body: {
          displayName: values.displayName,
          color: values.color,
          icon: values.icon,
        },
      },
    });
    if (authError) {
      form.setError("root", {
        message: authError.message ?? "Failed to create account",
      });
      return;
    }
    setSubmittedEmail(values.email);
    setMagicLinkSent(true);
  }

  function shuffleMark() {
    form.setValue("color", PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)]);
    form.setValue("icon", ICONS[Math.floor(Math.random() * ICONS.length)]);
  }

  const submitting = form.formState.isSubmitting;
  const rootError = form.formState.errors.root;

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
            <span className="font-medium text-foreground">{submittedEmail}</span>.
          </p>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              <Controller
                control={form.control}
                name="name"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                    <Input
                      {...field}
                      id={field.name}
                      type="text"
                      placeholder="Your name"
                      autoComplete="name"
                      disabled={submitting}
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.error && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="displayName"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={field.name}>Display name</FieldLabel>
                    <Input
                      {...field}
                      id={field.name}
                      type="text"
                      placeholder="sharkbait"
                      autoComplete="username"
                      disabled={submitting}
                      aria-invalid={fieldState.invalid}
                    />
                    <FieldDescription>
                      Shown next to your bets and on the leaderboard. Pick something memorable — you
                      can change it later.
                    </FieldDescription>
                    {fieldState.error && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />

              <FieldSet>
                <div className="flex items-center justify-between">
                  <FieldLegend variant="label">Profile mark</FieldLegend>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={shuffleMark}
                    disabled={submitting}
                  >
                    <Shuffle className="size-3" />
                    Shuffle
                  </Button>
                </div>
                <FieldDescription>
                  A color + icon combo that shows next to your bets and on the leaderboard.
                </FieldDescription>
                <FieldGroup>
                  <Controller
                    control={form.control}
                    name="color"
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <div
                          id={field.name}
                          role="radiogroup"
                          aria-label="Color"
                          aria-invalid={fieldState.invalid}
                          className="flex flex-wrap gap-2"
                        >
                          {PROFILE_COLORS.map((color) => {
                            const selected = field.value === color;
                            const hex = PROFILE_COLOR_HEX[color];
                            return (
                              <button
                                key={color}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                aria-label={color}
                                disabled={submitting}
                                onClick={() => field.onChange(color)}
                                style={{ backgroundColor: hex }}
                                className={cn(
                                  "size-7 rounded-full border border-black/10 transition-transform",
                                  "hover:scale-110",
                                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
                                  "disabled:pointer-events-none disabled:opacity-50",
                                  selected &&
                                    "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                                )}
                              />
                            );
                          })}
                        </div>
                        {fieldState.error && <FieldError errors={[fieldState.error]} />}
                      </Field>
                    )}
                  />

                  <Controller
                    control={form.control}
                    name="icon"
                    render={({ field, fieldState }) => {
                      const selectedColor = form.watch("color");
                      const tint = PROFILE_COLOR_HEX[selectedColor];
                      return (
                        <Field data-invalid={fieldState.invalid}>
                          <div
                            id={field.name}
                            role="radiogroup"
                            aria-label="Icon"
                            aria-invalid={fieldState.invalid}
                            className="flex flex-wrap gap-2"
                          >
                            {ICONS.map((icon) => {
                              const Icon = ICON_COMPONENTS[icon];
                              const selected = field.value === icon;
                              return (
                                <button
                                  key={icon}
                                  type="button"
                                  role="radio"
                                  aria-checked={selected}
                                  aria-label={icon}
                                  disabled={submitting}
                                  onClick={() => field.onChange(icon)}
                                  style={selected ? { color: tint, borderColor: tint } : undefined}
                                  className={cn(
                                    "flex size-11 items-center justify-center rounded-md border bg-background transition-colors",
                                    "hover:bg-accent",
                                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
                                    "disabled:pointer-events-none disabled:opacity-50",
                                    selected && "bg-accent",
                                  )}
                                >
                                  <Icon className="size-5" aria-hidden />
                                </button>
                              );
                            })}
                          </div>
                          {fieldState.error && <FieldError errors={[fieldState.error]} />}
                        </Field>
                      );
                    }}
                  />
                </FieldGroup>
              </FieldSet>

              <Controller
                control={form.control}
                name="email"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={field.name}>Email</FieldLabel>
                    <Input
                      {...field}
                      id={field.name}
                      type="email"
                      placeholder="you@example.com"
                      autoComplete="email"
                      disabled={submitting}
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.error && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />

              <Button type="submit" disabled={submitting}>
                {submitting ? "Sending..." : "Sign up with magic link"}
              </Button>

              {rootError?.message && <FieldError errors={[{ message: rootError.message }]} />}
            </FieldGroup>
          </form>
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
