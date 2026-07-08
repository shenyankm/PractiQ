# OpenWook Visual Style Guide

## Direction

OpenWook uses HeroUI v3 as the only frontend UI component system. Pages should compose standard components from `@heroui/react` and keep HeroUI's native layout, spacing, color, focus, and motion behavior.

## Tokens

The source of truth is `frontend/src/styles/globals.css`, which imports Tailwind CSS v4 followed by `@heroui/styles`. Use HeroUI semantic variants and existing theme variables rather than raw palette utilities or local component classes.

- Use `primary`, `secondary`, `tertiary`, `danger`, `ghost`, and `outline` variants according to action intent.
- Use `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--border`, `--input`, and `--ring` through HeroUI/Tailwind theme integration.
- Do not add project-specific component utility classes for buttons, cards, form controls, dialogs, or focus rings.

## Component Patterns

- Import standard components directly from `@heroui/react`.
- Use HeroUI `Button`, `Link`, `Card`, `Alert`, `EmptyState`, `Select`, `RadioGroup`, `Checkbox`, `Input`, `TextArea`, `Tabs`, dialog, and form primitives where applicable.
Keep native hidden inputs when required for forms, but visible form controls should use HeroUI components.
- Avoid page-level `bg-primary`, `text-primary`, and `border-primary`; prefer component variants and semantic theme tokens.
Avoid raw `blue-*`, `emerald-*`, `slate-*`, and `gray-*` utilities in frontend routes.

## Accessibility

- Use visible labels for form fields; placeholders are examples only.
- Prefer HeroUI interaction props such as `onPress` for HeroUI buttons.
- Do not rely on color alone for state; combine icon, text, label, or `aria-current`.
- Preserve keyboard navigation and accessible names for every interactive element.
