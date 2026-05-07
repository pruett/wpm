---
name: shadcn-svelte
description: >
  Manages shadcn-svelte components — adding, composing, fixing, debugging, styling, and building UI
  in Svelte 5 projects that use shadcn-svelte (the Svelte port of shadcn/ui). Provides project context,
  component authoring rules, and composition patterns. Triggers on shadcn-svelte work, "add a component",
  "compose a component", "create a component", "fix this component", or any work involving
  packages/web/src/lib/components/ui/.
---

# shadcn-svelte

A framework for building UI components and design systems in Svelte 5. Components are added as
source code to the project via the CLI and customized in place.

> **CLI command:** Always use `bun x shadcn-svelte@latest` as the package runner.
> Example: `bun x shadcn-svelte@latest add badge`

## Project Context

- **Framework:** SvelteKit
- **Package manager:** bun
- **Primitive library:** bits-ui (headless Svelte components)
- **Variant library:** tailwind-variants (`tv`)
- **Utility:** `cn()` from `$lib/utils.js` (clsx + tailwind-merge)
- **UI path:** `packages/web/src/lib/components/ui/`
- **Import alias:** `$lib/components/ui/...`
- **Svelte version:** Svelte 5 (runes mode — `$props()`, `$state()`, `$derived()`, `$effect()`, `$bindable()`)

## Principles

1. **Use existing components first.** Check `packages/web/src/lib/components/ui/` and run `bun x shadcn-svelte@latest add --dry-run` before writing custom UI.
2. **Compose, don't reinvent.** Settings page = Tabs + Card + form controls. Dashboard = Card + Badge + Separator.
3. **Use built-in variants before custom styles.** `variant="outline"`, `size="sm"`, etc.
4. **Use semantic colors.** `bg-primary`, `text-muted-foreground` — never raw values like `bg-blue-500`.

## Critical Rules

These rules are **always enforced**. Each links to detailed Incorrect/Correct examples.

### Styling & Tailwind → [styling.md](./rules/styling.md)

- **`class` for layout, not styling.** Never override component colors or typography.
- **No `space-x-*` or `space-y-*`.** Use `flex` with `gap-*`. For vertical stacks, `flex flex-col gap-*`.
- **Use `size-*` when width and height are equal.** `size-10` not `w-10 h-10`.
- **Use `truncate` shorthand.** Not `overflow-hidden text-ellipsis whitespace-nowrap`.
- **No manual `dark:` color overrides.** Use semantic tokens (`bg-background`, `text-muted-foreground`).
- **Use `cn()` for conditional classes.** Don't write manual template literal ternaries.
- **No manual `z-index` on overlay components.** Dialog, Popover, Tooltip, etc. handle their own stacking.

### Component Composition → [composition.md](./rules/composition.md)

- **Dialog always needs a Title.** `Dialog.Title` required for accessibility. Use `class="sr-only"` if visually hidden.
- **Use full Card composition.** `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`. Don't dump everything in `CardContent`.
- **Avatar always needs a fallback.** For when the image fails to load.
- **Use `Separator`** instead of `<hr>` or `<div class="border-t">`.
- **Use `Skeleton`** for loading placeholders. No custom `animate-pulse` divs.
- **Use `Badge`** instead of custom styled spans.
- **Toast via `svelte-sonner`.** Use `toast()` from `svelte-sonner`.

### Icons → [icons.md](./rules/icons.md)

- **Use the project's icon library for imports.** Check what's installed (`lucide-svelte`, `@tabler/icons-svelte`, etc.).
- **No sizing classes on icons inside components.** Components handle icon sizing via CSS.
- **Pass icons as Svelte components, not string keys.**

### Component Authoring → [authoring.md](./rules/authoring.md)

- **Svelte 5 runes only.** `$props()`, `$bindable()`, `$state()`, `$derived()`, `$effect()`.
- **Snippets for children.** `children?: import("svelte").Snippet` + `{@render children?.()}`.
- **One `.svelte` file per sub-component** + an `index.ts` barrel file.
- **`tailwind-variants` (`tv`) for variants**, not CVA.
- **`bits-ui` for headless primitives**, not Radix/Base UI.
- **Dual exports in `index.ts`.** `Root` + `Root as Card` pattern.
- **Every component: `class` prop + `cn()` merge + `...restProps` spread.**

## Key Patterns

These are the most common patterns that differentiate correct shadcn-svelte code.

```svelte
<!-- Semantic colors, not raw values -->
<div class="bg-primary text-primary-foreground">
  <p class="text-muted-foreground">Secondary text</p>
</div>

<!-- gap-*, not space-y-* -->
<div class="flex flex-col gap-4">
  <Input />
  <Button>Submit</Button>
</div>

<!-- size-* when equal, not w-* h-* -->
<div class="size-10" />

<!-- Badge for status, not custom spans -->
<Badge variant="secondary">+20.1%</Badge>

<!-- cn() for conditional classes -->
<div class={cn("flex items-center", isActive && "bg-primary")} />
```

### Svelte 5 Component Pattern

```svelte
<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";

  let {
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLDivElement> & {
    children?: import("svelte").Snippet;
  } = $props();
</script>

<div class={cn("base-classes", className)} {...restProps}>
  {@render children?.()}
</div>
```

### Variant Component Pattern

```svelte
<!-- component.svelte -->
<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  import { type MyVariant, myVariants } from "./index.js";

  let {
    class: className,
    variant = "default",
    children,
    ...restProps
  }: HTMLButtonAttributes & {
    variant?: MyVariant;
    children?: import("svelte").Snippet;
  } = $props();
</script>

<button class={cn(myVariants({ variant }), className)} {...restProps}>
  {@render children?.()}
</button>
```

```ts
// index.ts
import { tv, type VariantProps } from "tailwind-variants";
export { default as MyComponent } from "./my-component.svelte";

export const myVariants = tv({
  base: "...",
  variants: {
    variant: {
      default: "...",
      outline: "...",
    },
  },
  defaultVariants: { variant: "default" },
});

export type MyVariant = VariantProps<typeof myVariants>["variant"];
```

### bits-ui Primitive Wrapper Pattern

```svelte
<!-- dialog-content.svelte -->
<script lang="ts">
  import { Dialog } from "bits-ui";
  import { cn } from "$lib/utils.js";
  import DialogOverlay from "./dialog-overlay.svelte";

  let {
    class: className,
    children,
    ...restProps
  }: Dialog.ContentProps = $props();
</script>

<Dialog.Portal>
  <DialogOverlay />
  <Dialog.Content
    class={cn("fixed left-[50%] top-[50%] ...", className)}
    {...restProps}
  >
    {@render children?.()}
  </Dialog.Content>
</Dialog.Portal>
```

```ts
// index.ts — dual-export pattern for primitive wrappers
import { Dialog as DialogPrimitive } from "bits-ui";
import Content from "./dialog-content.svelte";
import Title from "./dialog-title.svelte";

const Root = DialogPrimitive.Root;
const Trigger = DialogPrimitive.Trigger;
const Close = DialogPrimitive.Close;

export {
  Root,
  Trigger,
  Close,
  Content,
  Title,
  Root as Dialog,
  Content as DialogContent,
  Title as DialogTitle,
  Trigger as DialogTrigger,
  Close as DialogClose,
};
```

## Component Selection

| Need          | Use                                                           |
| ------------- | ------------------------------------------------------------- |
| Button/action | `Button` with appropriate variant                             |
| Form inputs   | `Input`, `Select`, `Switch`, `Checkbox`, `Textarea`, `Slider` |
| Data display  | `Card`, `Badge`, `Avatar`, `Separator`                        |
| Navigation    | `Tabs`, `Breadcrumb`                                          |
| Overlays      | `Dialog` (modal), `AlertDialog` (confirmation), `Popover`     |
| Feedback      | `svelte-sonner` (toast), `Alert`, `Skeleton`                  |
| Tooltips/info | `Tooltip`, `Popover`                                          |
| Layout        | `Card`, `Separator`, `Accordion`, `Collapsible`, `ScrollArea` |

## CLI Quick Reference

```bash
# Add components
bun x shadcn-svelte@latest add button card dialog
bun x shadcn-svelte@latest add --all

# Preview changes before adding/updating
bun x shadcn-svelte@latest add button --dry-run

# List available components
bun x shadcn-svelte@latest add
```

## Workflow

1. **Check installed components first** — list `packages/web/src/lib/components/ui/` before running `add`. Don't import components that haven't been added, and don't re-add ones already installed.
2. **Install components** — `bun x shadcn-svelte@latest add <component>`.
3. **Review added components** — After adding a component, **always read the added files** and verify they follow the project's patterns. Check for missing imports, incorrect composition, or violations of the [Critical Rules](#critical-rules). Fix all issues before moving on.
4. **Compose new components** — follow the authoring rules in [authoring.md](./rules/authoring.md). Read 2–3 existing components in `packages/web/src/lib/components/ui/` to calibrate to project conventions before writing.

## Detailed References

- [rules/styling.md](./rules/styling.md) — Semantic colors, variants, class, spacing, size, truncate, dark mode, cn(), z-index
- [rules/composition.md](./rules/composition.md) — Dialog, Card, Avatar, Alert, Toast, Separator, Skeleton, Badge
- [rules/icons.md](./rules/icons.md) — Icon sizing, passing icons as components
- [rules/authoring.md](./rules/authoring.md) — Full component authoring rules for creating new shadcn-svelte components
