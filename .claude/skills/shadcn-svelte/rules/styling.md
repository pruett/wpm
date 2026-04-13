# Styling & Tailwind

## Contents

- Semantic colors
- No raw color values for status indicators
- Built-in variants first
- class for layout only
- No space-x-_ / space-y-_
- Prefer size-_ over w-_ h-\* when equal
- Prefer truncate shorthand
- No manual dark: color overrides
- Use cn() for conditional classes
- No manual z-index on overlay components

---

## Semantic colors

**Incorrect:**

```svelte
<div class="bg-blue-500 text-white">
  <p class="text-gray-600">Secondary text</p>
</div>
```

**Correct:**

```svelte
<div class="bg-primary text-primary-foreground">
  <p class="text-muted-foreground">Secondary text</p>
</div>
```

---

## No raw color values for status/state indicators

For positive, negative, or status indicators, use Badge variants, semantic tokens
like `text-destructive`, or define custom CSS variables — don't reach for raw Tailwind colors.

**Incorrect:**

```svelte
<span class="text-emerald-600">+20.1%</span>
<span class="text-green-500">Active</span>
<span class="text-red-600">-3.2%</span>
```

**Correct:**

```svelte
<Badge variant="secondary">+20.1%</Badge>
<Badge>Active</Badge>
<span class="text-destructive">-3.2%</span>
```

---

## Built-in variants first

**Incorrect:**

```svelte
<Button class="border border-input bg-transparent hover:bg-accent">
  Click me
</Button>
```

**Correct:**

```svelte
<Button variant="outline">Click me</Button>
```

---

## class for layout only

Use `class` for layout (e.g. `max-w-md`, `mx-auto`, `mt-4`), **not** for overriding
component colors or typography.

**Incorrect:**

```svelte
<Card class="bg-blue-100 text-blue-900 font-bold">
  <CardContent>Dashboard</CardContent>
</Card>
```

**Correct:**

```svelte
<Card class="max-w-md mx-auto">
  <CardContent>Dashboard</CardContent>
</Card>
```

Customization priority:

1. **Built-in variants** — `variant="outline"`, `variant="destructive"`, etc.
2. **Semantic color tokens** — `bg-primary`, `text-muted-foreground`.
3. **CSS variables** — define custom colors in the global CSS file.

---

## No space-x-_ / space-y-_

Use `gap-*` instead. `space-y-4` → `flex flex-col gap-4`. `space-x-2` → `flex gap-2`.

**Incorrect:**

```svelte
<div class="space-y-4">
  <Input />
  <Input />
  <Button>Submit</Button>
</div>
```

**Correct:**

```svelte
<div class="flex flex-col gap-4">
  <Input />
  <Input />
  <Button>Submit</Button>
</div>
```

---

## Prefer size-_ over w-_ h-\* when equal

`size-10` not `w-10 h-10`. Applies to icons, avatars, skeletons, etc.

---

## Prefer truncate shorthand

`truncate` not `overflow-hidden text-ellipsis whitespace-nowrap`.

---

## No manual dark: color overrides

Use semantic tokens — they handle light/dark via CSS variables.
`bg-background text-foreground` not `bg-white dark:bg-gray-950`.

---

## Use cn() for conditional classes

Use the `cn()` utility from `$lib/utils.js` for conditional or merged class names.
Don't write manual ternaries in class strings.

**Incorrect:**

```svelte
<div class={`flex items-center ${isActive ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
```

**Correct:**

```svelte
<script lang="ts">
  import { cn } from "$lib/utils.js";
</script>

<div class={cn("flex items-center", isActive ? "bg-primary text-primary-foreground" : "bg-muted")}>
```

---

## No manual z-index on overlay components

`Dialog`, `Popover`, `Tooltip`, `AlertDialog`, `DropdownMenu` handle their own stacking
via bits-ui. Never add `z-50` or `z-[999]`.
