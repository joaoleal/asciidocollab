# asciidocollab UI — how to build with it

The primitives are shadcn/ui components (Radix + `class-variance-authority`) styled with Tailwind utilities over an HSL **CSS custom-property token layer**. The brand anchor is AsciiDoc teal (`--primary`, `#1F8197`).

## Setup — no provider needed
Components render correctly with **no context/theme provider**. Two requirements:
1. `styles.css` must be loaded — it carries the compiled utilities, the component styles (`_ds_bundle.css`), and the token layer. Without it components are unstyled.
2. **Theme** is class-based: tokens are defined on `:root` (light) and `.dark` (dark). Put `class="dark"` on an ancestor (e.g. `<html>`) to switch the whole tree to dark. Every token has both values, so all components theme automatically — never hard-code colors.

## Styling idiom — tokens + utilities, extend via `className`
Style through the DS tokens, not raw hex. Tokens are HSL triplets, consumed as `hsl(var(--token))`:

- Surfaces/text: `--background` `--foreground` `--card` `--card-foreground` `--popover` `--muted` `--muted-foreground` `--accent` `--border` `--input` `--ring`
- Brand/intent: `--primary` (teal) `--secondary` `--destructive` (+ each `-foreground`)
- Semantic status: `--success` `--warning` `--info` (each also `-bg` / `-border`)
- Shape: `--radius` (0.5rem)

Prefer the matching Tailwind utilities — `bg-primary text-primary-foreground`, `bg-secondary`, `border-input`, `bg-muted`, `text-muted-foreground`, `rounded-md`, `rounded-lg`. Every component takes `className` to extend; pass utilities there rather than inline styles.

Variant props (from `cva`), not classes, drive appearance:
- `Button`: `variant` = default | secondary | outline | destructive | ghost | link; `size` = default | sm | lg | icon; `asChild` to wrap a link.
- `Badge`: `variant` = default | secondary | destructive | outline.
- `Progress`: `value` 0–100. `Input`: native input props. `Label`: pair via `htmlFor`.
- `Card` is compound: `Card > CardHeader > {CardTitle, CardDescription}`, then `CardContent`, `CardFooter`.
- `DropdownMenu` is compound: `DropdownMenu > DropdownMenuTrigger (asChild) + DropdownMenuContent > DropdownMenuItem | DropdownMenuSeparator`.
- Loading: `Skeleton` (pass a size via `className`, e.g. `h-4 w-48`), `Spinner`, `PageSkeleton`. `ResizeHandle` is a panel divider (`ariaLabel`, `onPointerDown`, `isResizing`).

## Where the truth lives
Read `styles.css` (and its `@import` closure — tokens + `_ds_bundle.css`) before styling, and each component's `<Name>.d.ts` (props) and `<Name>.prompt.md` (usage). All exports live on the bundle; import from the package.

## Idiomatic snippet — a review-comment card
```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Badge, Button } from '@asciidocollab/web';

<Card className="max-w-sm">
  <CardHeader>
    <div className="flex items-center justify-between gap-2">
      <CardTitle className="text-base">Tighten the intro</CardTitle>
      <Badge variant="secondary">In review</Badge>
    </div>
    <CardDescription>joao commented on §2 · 2h ago</CardDescription>
  </CardHeader>
  <CardContent className="text-sm text-muted-foreground">
    Can we cut this to one sentence and link the concepts guide?
  </CardContent>
  <CardFooter className="gap-2">
    <Button size="sm">Reply</Button>
    <Button size="sm" variant="outline">Resolve</Button>
  </CardFooter>
</Card>
```
