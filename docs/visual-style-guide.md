# PractiQ Taro Visual Style Guide

## Direction

Use `@tarojs/components` and plain CSS for the WeChat Mini Program. Do not add a component library or theme layer until a migrated feature proves Taro primitives insufficient.

## Sources of Truth

- `taro/src/app.css` contains app-wide styles.
- `taro/src/pages/` contains page-level JSX, config, and CSS.
- `taro/src/app.config.ts` owns global window and navigation settings.

Keep platform checks out of visual components unless Taro lacks a unified API. Extract a shared component only after the same interaction appears in more than one migrated flow.

## Component Patterns

- Use Taro `View`, `Text`, `Button`, `Input`, `Image`, and list primitives.
- Keep page config next to each page.
- Keep loading, empty, error, and disabled states visible and consistent.
- Prefer CSS sizing and layout supported by the WeChat Mini Program.
- Preserve the PractiQ green palette already used by the status page.

## Accessibility

- Give inputs visible labels; placeholders are examples, not labels.
- Give icon-only and non-text controls descriptive accessibility names.
- Do not rely on color alone for state.
- Preserve scalable text, minimum touch targets, screen-reader names, safe areas, and reduced-motion behavior.
