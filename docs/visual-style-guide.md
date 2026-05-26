# OpenWook Visual Style Guide

## Direction

OpenWook uses a minimalist, grayscale-first interface with subtle glassmorphism for depth. The design system should preserve clarity for content-heavy education workflows: surfaces are quiet, type hierarchy is explicit, and color is reserved for semantic state only.

## Tokens

The source of truth is `app/globals.css`. Use semantic Tailwind tokens rather than raw palette utilities.

- Background: `--background` / `--foreground`
- Surfaces: `--card`, `--popover`, `--muted`, `--accent`
- Actions: `--primary` is grayscale black/white, not brand blue
- Lines: `--border`, `--input`, `--line-subtle`
- Focus: `--ring`
- Glass: `--glass-bg`, `--glass-border`, `--glass-shadow`
- Radius: `--radius: 0.75rem`

Reusable utilities:

- `ow-glass`: translucent surface, border, shadow, blur, and saturation
- `ow-surface`: semantic card-like neutral surface
- `ow-hairline`: subtle separator/border color
- `ow-focus`: shared accessible focus ring

## Component Patterns

- Buttons use semantic variants from `components/ui/button.tsx`; page code should choose variants, not override colors.
- Cards are glass surfaces by default and should be composed with `CardHeader`, `CardTitle`, `CardContent`, and `CardFooter`.
- Inputs, selects, textareas, and toggles use translucent neutral backgrounds with a visible ring focus state.
- Dialogs, popovers, dropdowns, selects, and tooltips use blur/elevation for depth and keep titles/labels accessible.
- Tables and list rows use low-contrast hairlines, hover via `accent`, and typography for hierarchy.
- Status treatment is grayscale by default. Keep destructive red only for destructive/error states.

## Page Rules

- Avoid page-level `bg-primary`, `text-primary`, and `border-primary`; use `text-foreground`, `text-muted-foreground`, `bg-foreground/10`, `border-ring`, or component variants.
- Avoid raw `blue-*`, `emerald-*`, `slate-*`, and `gray-*` utilities in app routes.
- Use `Card`, `Alert`, `Empty`, `Separator`, `Skeleton`, and form primitives instead of bespoke visible UI markup.
- Maintain responsive spacing: `px-4`, `py-6`, `lg:px-8`, `lg:py-8`, card content `p-4 sm:p-6`.
- Keep motion behind `motion-safe` / `motion-reduce` patterns.

## Accessibility

- Use visible labels for form fields; placeholders are examples only.
- Preserve focus rings on every interactive element.
- Do not rely on color alone for state; combine icon, text, label, or `aria-current`.
- Keep touch targets at least 24px; core actions use 40px+ heights.
- Ensure glass surfaces remain readable by pairing translucency with enough opacity and foreground contrast.
