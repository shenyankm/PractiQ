# PractiQ Mobile Visual Style Guide

## Direction

PractiQ uses HeroUI Native for visible controls and Uniwind utilities for React Native layout. Reuse the shared components under `mobile/src/components/` before introducing a page-local wrapper.

## Sources of Truth

- `mobile/global.css` imports Tailwind CSS, Uniwind, and `heroui-native/styles`.
- `mobile/app/_layout.tsx` owns the root `HeroUINativeProvider`, safe-area handling, theme colors, reduced-motion behavior, and navigation shell.
- `mobile/src/components/` contains shared screen, section, tab, and statistic-card patterns.

Use semantic classes such as `bg-background` and HeroUI Native variants instead of hard-coded palette colors. Use `className` for layout and spacing; use component props for interaction state and intent.

## Component Patterns

- Import HeroUI Native components from their package subpaths, for example `heroui-native/button` and `heroui-native/card`.
- Use `Surface` for layout containers, `Typography` for visible text, and HeroUI Native form controls for input.
- Prefer existing `ScreenState`, `Section`, `PrimaryTabs`, and `StatCard` components when their current behavior fits.
- Center the sign-in content vertically while keeping its scroll behavior for registration and small screens.
- Keep route files under `mobile/app/` thin; reusable screen behavior belongs under `mobile/src/`.
- Do not add another component library or a second theme layer.

## Accessibility

- Give inputs visible `Label` components; placeholders are examples, not labels.
- Give icon-only buttons, spinners, and non-text controls an `accessibilityLabel`.
- Do not rely on color alone for state; pair it with text, icons, or selected-state semantics.
- Preserve safe areas, scalable text, minimum touch targets, screen-reader names, and reduced-motion behavior.
