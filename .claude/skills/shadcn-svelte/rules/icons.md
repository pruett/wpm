# Icons

**Always use the project's configured icon library for imports.** Check what's installed
in `package.json` — common options are `lucide-svelte`, `@tabler/icons-svelte`,
`svelte-radix`, etc. Never assume a specific icon library.

---

## No sizing classes on icons inside components

Components handle icon sizing via CSS. Don't add `size-4`, `w-4 h-4`, or other sizing
classes to icons inside `Button`, `DropdownMenuItem`, `Alert`, or other shadcn-svelte
components — unless the user explicitly asks for custom icon sizes.

**Incorrect:**

```svelte
<Button>
  <SearchIcon class="size-4 mr-2" />
  Search
</Button>
```

**Correct:**

```svelte
<Button>
  <SearchIcon />
  Search
</Button>
```

---

## Pass icons as Svelte components, not string keys

Import and use icon components directly. Don't use string-based lookups.

**Incorrect:**

```svelte
<script lang="ts">
  const iconMap: Record<string, any> = {
    check: CheckIcon,
    alert: AlertIcon,
  };
</script>

<svelte:component this={iconMap[iconName]} />
```

**Correct:**

```svelte
<script lang="ts">
  import { Check } from "lucide-svelte";
  import type { Component } from "svelte";

  let { icon: Icon }: { icon: Component } = $props();
</script>

<Icon />
```

Usage:

```svelte
<StatusBadge icon={Check} />
```

---

## Icons as snippet props (advanced)

When a component needs to accept an icon that may need custom rendering:

```svelte
<script lang="ts">
  let {
    icon,
    children,
    ...restProps
  }: {
    icon?: import("svelte").Snippet;
    children?: import("svelte").Snippet;
  } = $props();
</script>

<button {...restProps}>
  {#if icon}
    {@render icon()}
  {/if}
  {@render children?.()}
</button>
```

Usage:

```svelte
<MyButton>
  {#snippet icon()}
    <SearchIcon />
  {/snippet}
  Search
</MyButton>
```
