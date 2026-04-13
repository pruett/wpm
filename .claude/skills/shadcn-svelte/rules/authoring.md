# Component Authoring Rules

Rules for creating new shadcn-svelte components. Every component produced MUST follow these rules.
Read 2–3 existing components in `packages/web/src/lib/components/ui/` before writing new ones.

---

## 1. File Structure

One directory per component family. Each sub-component gets its own `.svelte` file.
An `index.ts` barrel file handles exports and variant definitions.

```
packages/web/src/lib/components/ui/
└── swipe-card/
    ├── swipe-card.svelte
    ├── swipe-card-header.svelte
    ├── swipe-card-content.svelte
    ├── swipe-card-footer.svelte
    └── index.ts
```

---

## 2. Component Script Structure

Every `.svelte` component follows this exact structure:

```svelte
<script lang="ts">
  // 1. Type imports
  import type { HTMLAttributes } from "svelte/elements";

  // 2. Utility imports
  import { cn } from "$lib/utils.js";

  // 3. Variant/component imports (if needed)
  import { type MyVariant, myVariants } from "./index.js";

  // 4. Props destructuring with $props()
  let {
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLDivElement> & {
    children?: import("svelte").Snippet;
  } = $props();
</script>

<!-- 5. Template -->
<div class={cn("base-classes", className)} {...restProps}>
  {@render children?.()}
</div>
```

Key points:

- Always use `<script lang="ts">`
- Always destructure `class` as `className` (reserved word in Svelte)
- Always spread `...restProps` on the root element
- Always merge classes with `cn()`, consumer `className` last

---

## 3. Props and Typing

Use HTML attribute types from `"svelte/elements"`, intersected with custom props inline.

```svelte
<!-- Simple — no custom props -->
<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";

  let {
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLDivElement> & {
    children?: import("svelte").Snippet;
  } = $props();
</script>
```

```svelte
<!-- Custom props — intersection type inline -->
<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";

  let {
    class: className,
    variant = "default",
    size = "default",
    children,
    ...restProps
  }: HTMLButtonAttributes & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    children?: import("svelte").Snippet;
  } = $props();
</script>
```

```svelte
<!-- Wrapping a bits-ui primitive — use the primitive's prop type -->
<script lang="ts">
  import { Dialog } from "bits-ui";

  let {
    class: className,
    children,
    ...restProps
  }: Dialog.ContentProps = $props();
</script>
```

Common HTML attribute types from `"svelte/elements"`:

- `HTMLAttributes<HTMLDivElement>` — div, section, article, header, footer, nav
- `HTMLButtonAttributes` — button
- `HTMLInputAttributes` — input
- `HTMLAnchorAttributes` — a
- `HTMLFormAttributes` — form
- `HTMLSelectAttributes` — select
- `HTMLTextareaAttributes` — textarea

---

## 4. Children via Snippets

Svelte 5 uses snippets instead of slot-based children. Every component that accepts
children must declare and render them:

```svelte
<script lang="ts">
  let {
    children,
    ...restProps
  }: { children?: import("svelte").Snippet } = $props();
</script>

<div {...restProps}>
  {@render children?.()}
</div>
```

For typed/parameterized snippets (render delegation):

```svelte
<script lang="ts">
  let {
    child,
    ...restProps
  }: { child?: import("svelte").Snippet<[{ props: Record<string, any> }]> } = $props();
</script>

{#snippet child({ props })}
  <div {...props}>Custom render</div>
{/snippet}
```

---

## 5. Two-Way Binding with `$bindable()`

Use `$bindable()` for props that need two-way binding (form values, open state, refs):

```svelte
<script lang="ts">
  let {
    value = $bindable(""),
    open = $bindable(false),
    ref = $bindable(null),
    ...restProps
  } = $props();
</script>

<input bind:value {...restProps} />
```

Consumers bind with: `<Input bind:value={name} />`

---

## 6. Variants with tailwind-variants (`tv`)

Define variants in `index.ts` using `tv` from `tailwind-variants`, not CVA.

```ts
// index.ts
import { tv, type VariantProps } from "tailwind-variants";

export { default as Chip } from "./chip.svelte";

export const chipVariants = tv({
  base: "h-auto rounded-lg justify-center text-left relative",
  variants: {
    variant: {
      default: "border-border bg-background text-muted-foreground",
      outline: "border-border bg-input/30 text-muted-foreground",
    },
    size: {
      default: "px-4 py-2.5",
      sm: "px-3 py-1.5 text-xs",
      lg: "px-5 py-3 text-base",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export type ChipVariant = VariantProps<typeof chipVariants>["variant"];
export type ChipSize = VariantProps<typeof chipVariants>["size"];
```

The component imports and uses the variants:

```svelte
<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  import { type ChipVariant, type ChipSize, chipVariants } from "./index.js";

  let {
    class: className,
    variant = "default",
    size = "default",
    children,
    ...restProps
  }: HTMLButtonAttributes & {
    variant?: ChipVariant;
    size?: ChipSize;
    children?: import("svelte").Snippet;
  } = $props();
</script>

<button class={cn(chipVariants({ variant, size }), className)} {...restProps}>
  {@render children?.()}
</button>
```

---

## 7. The `data-slot` Attribute

Use `data-slot` on root elements for CSS targeting when appropriate.
This enables parent components to target children via `has-data-[slot=...]`.

```svelte
<TooltipPrimitive.Content
  data-slot="tooltip-content"
  class={cn("...", className)}
  {...restProps}
>
  {@render children?.()}
</TooltipPrimitive.Content>
```

---

## 8. Wrapping bits-ui Primitives

When wrapping bits-ui primitives:

1. Import the primitive namespace from `bits-ui`
2. Use the primitive's prop types (e.g., `Dialog.ContentProps`)
3. Add `class` merging and `...restProps` spreading
4. Re-export primitives that need no customization directly from the index

```svelte
<!-- dialog-overlay.svelte -->
<script lang="ts">
  import { Dialog } from "bits-ui";
  import { cn } from "$lib/utils.js";

  let {
    class: className,
    ...restProps
  }: Dialog.OverlayProps = $props();
</script>

<Dialog.Overlay
  class={cn("fixed inset-0 z-50 bg-black/80", className)}
  {...restProps}
/>
```

```ts
// index.ts — re-export primitives that need no wrapper
import { Dialog as DialogPrimitive } from "bits-ui";

const Root = DialogPrimitive.Root;
const Trigger = DialogPrimitive.Trigger;
const Close = DialogPrimitive.Close;
```

---

## 9. Index File / Barrel Exports

Every component family has an `index.ts` with dual exports — short names and
prefixed PascalCase names:

```ts
import Root from "./card.svelte";
import Header from "./card-header.svelte";
import Title from "./card-title.svelte";
import Content from "./card-content.svelte";
import Footer from "./card-footer.svelte";

export {
  Root,
  Header,
  Title,
  Content,
  Footer,
  // PascalCase aliases for direct import
  Root as Card,
  Header as CardHeader,
  Title as CardTitle,
  Content as CardContent,
  Footer as CardFooter,
};
```

For components with variants, define them in `index.ts`:

```ts
import { tv, type VariantProps } from "tailwind-variants";
import Badge from "./badge.svelte";

const badgeVariants = tv({ ... });
type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

export { Badge, badgeVariants, type BadgeVariant };
```

---

## 10. Context for Shared State

When parent components need to distribute state to children, use Svelte's
`getContext` / `setContext`:

```svelte
<!-- toggle-group.svelte (parent) -->
<script lang="ts">
  import { setContext } from "svelte";

  let { variant = "default", size = "default", children, ...restProps } = $props();

  setContext("toggle-group", { variant, size });
</script>
```

```svelte
<!-- toggle-group-item.svelte (child) -->
<script lang="ts">
  import { getContext } from "svelte";

  const ctx = getContext<{ variant: string; size: string }>("toggle-group");
  let { variant = ctx?.variant ?? "default", ...restProps } = $props();
</script>
```

**When to use context:**

- Parent distributes shared configuration to multiple children (variant, size, orientation)
- Prop drilling would be 2+ levels deep

**When NOT to use context:**

- Simple layout containers that just wrap children with styling
- Components with no shared state between parent and children

---

## 11. Ref Forwarding

Use `$bindable(null)` for ref forwarding with `bind:ref`:

```svelte
<script lang="ts">
  import { Separator as SeparatorPrimitive } from "bits-ui";

  let {
    ref = $bindable(null),
    ...restProps
  }: SeparatorPrimitive.RootProps = $props();
</script>

<SeparatorPrimitive.Root bind:ref {...restProps} />
```

---

## 12. Naming Conventions

| Concept          | Convention                    | Example                    |
| ---------------- | ----------------------------- | -------------------------- |
| Directory name   | kebab-case                    | `swipe-card/`              |
| File name        | kebab-case                    | `swipe-card-header.svelte` |
| Component export | PascalCase, prefixed          | `SwipeCardHeader`          |
| Short export     | PascalCase, no prefix         | `Header`                   |
| data-slot value  | kebab-case                    | `swipe-card-header`        |
| tv variable      | camelCase + `Variants` suffix | `swipeCardVariants`        |
| Type export      | PascalCase + variant name     | `SwipeCardVariant`         |

---

## 13. Styling Rules

- **Semantic colors only** — `bg-card`, `text-muted-foreground`, never `bg-blue-500`
- **`gap-*` for spacing** — never `space-x-*` or `space-y-*`
- **`size-*` for equal dimensions** — `size-10` not `w-10 h-10`
- **`truncate` shorthand** — not `overflow-hidden text-ellipsis whitespace-nowrap`
- **`cn()` for conditional classes** — not template literal ternaries
- **No manual `dark:` overrides** — semantic tokens handle dark mode
- **No manual `z-index` on overlays** — let the primitive handle stacking
- **`class` for layout, not color overrides** — consumers use `class` for positioning (`mt-4`, `max-w-md`), not to restyle the component

---

## 14. Composing New Component Families

When creating a new composable component (not just adding a shadcn-svelte component):

### Phase 1: API Design (do NOT skip)

Before writing any code, define the component's public API:

1. **Name and purpose** — what it is, where it's used
2. **Sub-components** — what pieces compose the whole
3. **Element types** — what HTML element or bits-ui primitive each wraps
4. **Custom props** — beyond `class` and `children`
5. **Variants** — if any use `tv`, list variant names and values
6. **Context** — if parent needs to pass state to children

Present the spec:

```
Component: SwipeCard
Directory: packages/web/src/lib/components/ui/swipe-card/

Files:
  swipe-card.svelte           — div, props: { direction?: "horizontal" | "vertical" }
  swipe-card-header.svelte    — div, props: {}
  swipe-card-content.svelte   — div, props: {}
  swipe-card-footer.svelte    — div, props: {}
  swipe-card-action.svelte    — button, props: { variant?: "accept" | "reject" }
  index.ts                    — variants + dual exports

Context: direction flows from root
Variants: swipeCardActionVariants (variant: accept | reject)
```

**Wait for confirmation before writing code.**

### Phase 2: Implementation

Write all files following the rules above. Checklist:

- [ ] Every sub-component accepts and merges `class` via `cn(..., className)`
- [ ] Every sub-component spreads `...restProps` on its root element
- [ ] Types use HTML attribute types from `"svelte/elements"` intersected with custom props
- [ ] Primitives wrapper components use the primitive's prop types (e.g., `Dialog.ContentProps`)
- [ ] `cn()` imported from `$lib/utils.js`
- [ ] Variants use `tv` from `tailwind-variants`, defined in `index.ts`
- [ ] Children use snippets: `children?: import("svelte").Snippet` + `{@render children?.()}`
- [ ] `index.ts` has dual exports (short name + prefixed PascalCase)
- [ ] Semantic Tailwind tokens (`bg-card`, `text-muted-foreground`), no raw colors
- [ ] `gap-*` for spacing, never `space-x-*` / `space-y-*`
- [ ] `size-*` when width and height are equal

### Phase 3: Review

After writing:

1. Read back all files to confirm they follow project patterns.
2. Suggest usage examples showing the component composed in a realistic scenario.
3. Ask if any sub-components need additional props or variants.

---

## Anti-Patterns

Do NOT:

- Create a monolithic component with conditional rendering for sub-parts
- Bury styled divs inside a component — extract as composable sub-components
- Use `slot` (Svelte 4 pattern) — use snippets in Svelte 5
- Use `$$props` or `$$restProps` — use `$props()` destructuring
- Use `export let` — use `$props()` (Svelte 5 runes)
- Use CVA (`class-variance-authority`) — use `tv` from `tailwind-variants`
- Use inline styles for dynamic state — use `data-*` attributes with Tailwind `data-[state=*]:` modifiers
- Add default exports — use named exports via `index.ts`
- Skip the API design phase for new component families
- Over-engineer — only add context when state genuinely needs to flow down
