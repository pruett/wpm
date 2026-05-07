# Component Composition

## Contents

- Callouts use Alert
- Toast notifications use svelte-sonner
- Choosing between overlay components
- Dialog always needs a Title
- Card structure
- Avatar always needs a fallback
- Use Separator instead of raw hr or border divs
- Use Skeleton for loading placeholders
- Use Badge instead of custom styled spans

---

## Callouts use Alert

```svelte
<Alert>
  <AlertTitle>Warning</AlertTitle>
  <AlertDescription>Something needs attention.</AlertDescription>
</Alert>
```

---

## Toast notifications use svelte-sonner

```svelte
<script lang="ts">
  import { toast } from "svelte-sonner";

  function handleSave() {
    toast.success("Changes saved.");
  }

  function handleError() {
    toast.error("Something went wrong.");
  }
</script>
```

---

## Choosing between overlay components

| Use case                          | Component     |
| --------------------------------- | ------------- |
| Focused task that requires input  | `Dialog`      |
| Destructive action confirmation   | `AlertDialog` |
| Quick info on hover               | `Tooltip`     |
| Small contextual content on click | `Popover`     |

---

## Dialog always needs a Title

`Dialog.Title` (or `DialogTitle`) is required for accessibility. Use `class="sr-only"` if visually hidden.

```svelte
<Dialog.Root>
  <Dialog.Trigger>
    <Button>Edit Profile</Button>
  </Dialog.Trigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Edit Profile</DialogTitle>
      <DialogDescription>Update your profile information.</DialogDescription>
    </DialogHeader>
    <!-- content -->
  </DialogContent>
</Dialog.Root>
```

---

## Card structure

Use full composition — don't dump everything into `CardContent`:

```svelte
<Card>
  <CardHeader>
    <CardTitle>Team Members</CardTitle>
    <CardDescription>Manage your team.</CardDescription>
  </CardHeader>
  <CardContent>
    <!-- main content -->
  </CardContent>
  <CardFooter>
    <Button>Invite</Button>
  </CardFooter>
</Card>
```

---

## Avatar always needs a fallback

Always include a fallback for when the image fails to load:

```svelte
<Avatar>
  <AvatarImage src="/avatar.png" alt="User" />
  <AvatarFallback>JD</AvatarFallback>
</Avatar>
```

---

## Use existing components instead of custom markup

| Instead of                                     | Use                              |
| ---------------------------------------------- | -------------------------------- |
| `<hr>` or `<div class="border-t">`             | `<Separator />`                  |
| `<div class="animate-pulse">` with styled divs | `<Skeleton class="h-4 w-3/4" />` |
| `<span class="rounded-full bg-green-100 ...">` | `<Badge variant="secondary">`    |

---

## Use Separator instead of hr or border divs

```svelte
<Separator />
<Separator orientation="vertical" />
```

---

## Use Skeleton for loading placeholders

```svelte
<div class="flex flex-col gap-2">
  <Skeleton class="h-4 w-3/4" />
  <Skeleton class="h-4 w-1/2" />
</div>
```

---

## Use Badge instead of custom styled spans

**Incorrect:**

```svelte
<span class="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">Active</span>
```

**Correct:**

```svelte
<Badge variant="secondary">Active</Badge>
```
