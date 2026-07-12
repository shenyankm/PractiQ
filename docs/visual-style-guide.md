# OpenWook Visual Style Guide

## Direction

OpenWook uses HeroUI v3 as the only frontend UI component system. Pages must compose standard components from `@heroui/react` and preserve HeroUI's native layout, spacing, color, focus, and motion behavior.

## Tokens

The source of truth is `frontend/src/styles/globals.css`, which imports Tailwind CSS v4 followed by `@heroui/styles`. Use HeroUI semantic variants and existing theme tokens instead of raw palette utilities or local component classes.

- Use `primary`, `secondary`, `tertiary`, `danger`, `ghost`, and `outline` variants according to action intent.
- Use `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--border`, `--input`, and `--ring` through HeroUI/Tailwind theme integration.
- Do not add project-specific component utility classes for buttons, cards, form controls, dialogs, focus rings, or typography.

## Component Patterns

- Import standard components directly from `@heroui/react`.
- Use HeroUI `Avatar`, `Button`, `Checkbox`, `FieldGroup`, `InputGroup`, `Link`, `Card`, `Alert`, `EmptyState`, `Select`, `RadioGroup`, `Input`, `TextField`, `TextArea`, `Tabs`, dialog, and form primitives where applicable.
- Use HeroUI Typography for visible headings and paragraphs, and HeroUI Card compound components for card content.
- Do not pass `className`, `style`, or other style-override props to HeroUI components. Use documented semantic props, variants, and compound components instead.
- Native elements may provide structural page layout only. Keep native hidden inputs when required for forms; all visible form controls must use HeroUI components.
- Do not use page-level `bg-primary`, `text-primary`, or `border-primary`; prefer component variants and semantic theme tokens.
- Do not use raw `blue-*`, `emerald-*`, `slate-*`, or `gray-*` utilities anywhere in `frontend/src`.

## Accessibility

- Use visible labels for form fields; placeholders are examples only.
- Give progress indicators a visible label or `aria-label`.
- Prefer HeroUI interaction props such as `onPress` for HeroUI buttons.
- Do not rely on color alone for state; combine icon, text, label, or `aria-current`.
- Preserve keyboard navigation and accessible names for every interactive element.
