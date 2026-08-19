# PractiQ WeChat Mini Program Visual Style Guide

## Direction

Use plain CSS for the WeChat Mini Program. Do not add a component library or theme layer until a migrated feature proves native components insufficient.

## Sources of Truth

- `weapp/app.wxss` contains app-wide styles.
- `weapp/pages/` contains page-level WXML, JSON, WXSS, and JS.
- `weapp/app.json` owns global window and navigation settings.

Keep platform checks out of visual components unless native components lack a unified API. Extract a shared component only after the same interaction appears in more than one migrated flow.

## Component Patterns

- Use native `view`, `text`, `button`, `input`, `image`, and list components.
- Keep page config next to each page.
- Keep loading, empty, error, and disabled states visible and consistent.
- Prefer CSS sizing and layout supported by the WeChat Mini Program.
- Preserve the PractiQ green palette already used by the status page.

## Accessibility

- Give inputs visible labels; placeholders are examples, not labels.
- Give icon-only and non-text controls descriptive accessibility names.
- Do not rely on color alone for state.
- Preserve scalable text, minimum touch targets, screen-reader names, safe areas, and reduced-motion behavior.
