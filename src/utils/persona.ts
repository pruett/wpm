import { z } from "zod";
import type { UserPersona } from "../db/schema";
import { displayName } from "./format";

// Zod mirror of the UserPersona shape in db/schema.ts. It lives here, not in
// schema.ts, so that file stays a dependency-free leaf (no zod import). Every
// field is optional and z.object strips unknown keys, so a partial or
// slightly-stale hand-edit still yields whatever valid fields it does carry.
export const UserPersonaSchema = z.object({
  bullets: z.array(z.string()).optional(),
  nicknames: z.array(z.string()).optional(),
  rivalries: z.array(z.string()).optional(),
  team: z.string().optional(),
  tone: z.string().optional(),
});

// Compile-time tripwire: fails to build if the inferred schema shape ever
// drifts from the source-of-truth UserPersona type in db/schema.ts.
const _shapeMatches = (p: z.infer<typeof UserPersonaSchema>): UserPersona => p;
void _shapeMatches;

/**
 * Read guard for the users.persona jsonb column. The DB column is untyped at
 * runtime ($type<>() is compile-time only) and may be hand-edited, so the
 * stored value is genuinely `unknown` here. Personalization is purely additive
 * flavor — it must NEVER block an announcement — so anything that is absent or
 * fails to parse degrades to "no persona" (undefined) and the caller falls
 * back to its deterministic phrasing.
 */
export function parsePersona(raw: unknown): UserPersona | undefined {
  if (raw == null) return undefined;
  const result = UserPersonaSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** A persona-bearing user, reduced to what the block needs: a display name and the raw column. */
interface PersonaSubject {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  /** The raw users.persona jsonb value — validated here, not trusted. */
  persona?: unknown;
}

/** Collapse one validated persona into prompt fragments, dropping empty/blank fields. */
function personaFragments(p: UserPersona): string[] {
  const clean = (xs: string[] | undefined) => (xs ?? []).map((x) => x.trim()).filter(Boolean);
  const frags: string[] = [];
  const nicknames = clean(p.nicknames);
  if (nicknames.length) frags.push(`goes by ${nicknames.map((n) => `"${n}"`).join(", ")}`);
  if (p.team?.trim()) frags.push(p.team.trim());
  const rivalries = clean(p.rivalries);
  if (rivalries.length) frags.push(`loves needling ${rivalries.join(", ")}`);
  frags.push(...clean(p.bullets));
  // Steering for the model (roast intensity), set apart so it reads as direction, not a fact.
  if (p.tone?.trim()) frags.push(`(${p.tone.trim()})`);
  return frags;
}

/**
 * Build the optional persona context block appended to an announcer's LLM
 * prompt: one line per involved player who has hand-curated notes, keyed by the
 * exact display name the model already uses in the facts so it can connect the
 * two. Personalization is purely additive flavor — it must never block an
 * announcement — so a user with no persona, an unparseable one, or only blank
 * fields simply contributes nothing, and an all-empty set returns "" (the
 * caller then sends the facts-only prompt unchanged).
 */
export function personaPromptBlock(users: PersonaSubject[]): string {
  const entries: string[] = [];
  for (const u of users) {
    const persona = parsePersona(u.persona);
    if (!persona) continue;
    const frags = personaFragments(persona);
    if (frags.length === 0) continue;
    entries.push(`- ${displayName(u)}: ${frags.join("; ")}.`);
  }
  if (entries.length === 0) return "";
  return [
    "Persona notes — personalize the trash talk for these players where it fits naturally",
    "(use a nickname, poke their team, reference a rivalry). Skip any note that doesn't land,",
    "and never apply notes to a player who has none:",
    ...entries,
  ].join("\n");
}
