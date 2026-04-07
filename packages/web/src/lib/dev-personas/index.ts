/**
 * DEV-PERSONAS — encapsulated dev-only persona switcher.
 *
 * Reads personas written by the `scripts/admin.ts` CLI from
 * ~/.wpm-admin/personas.json and lets the browser impersonate any of them
 * via a cookie.
 *
 * Removal: delete this folder, delete src/routes/api/dev/, and remove the
 * two DEV-PERSONAS marker blocks in hooks.server.ts and routes/+layout.svelte.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dev } from "$app/environment";
import type { RequestEvent } from "@sveltejs/kit";

export const PERSONA_COOKIE = "wpm-dev-persona";

const PERSONAS_FILE = join(homedir(), ".wpm-admin", "personas.json");

export type DevPersona = {
  name: string;
  email: string;
  /** Token + address are also stored by the CLI but the browser doesn't need them. */
  address: string;
};

type StoredPersona = DevPersona & { token: string };

export function listPersonas(): DevPersona[] {
  if (!existsSync(PERSONAS_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(PERSONAS_FILE, "utf-8")) as StoredPersona[];
    return raw.map(({ name, email, address }) => ({ name, email, address }));
  } catch {
    return [];
  }
}

function findPersonaByEmail(email: string): DevPersona | undefined {
  return listPersonas().find((p) => p.email === email);
}

/**
 * Mutates `event.locals` to impersonate the persona named in the cookie.
 * No-op outside dev or when no cookie is set or the persona is unknown.
 *
 * The downstream proxy (lib/server/proxy.ts) only reads `email` and `name`,
 * so we synthesize a minimal user shape and a placeholder session.
 */
export function applyDevPersona(event: RequestEvent): void {
  if (!dev) return;
  const email = event.cookies.get(PERSONA_COOKIE);
  if (!email) return;

  const persona = findPersonaByEmail(email);
  if (!persona) return;

  // Synthesize a Better-Auth-shaped user. Existing consumers only read
  // `email` and `name`; everything else is a stub.
  event.locals.user = {
    id: `dev:${persona.email}`,
    name: persona.name,
    email: persona.email,
    emailVerified: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    image: null,
  } as App.Locals["user"];

  event.locals.session = {
    id: `dev:${persona.email}`,
    userId: `dev:${persona.email}`,
    token: "dev",
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ipAddress: null,
    userAgent: null,
  } as App.Locals["session"];
}
