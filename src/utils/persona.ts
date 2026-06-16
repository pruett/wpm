import { z } from "zod";
import type { UserPersona } from "../db/schema";

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
