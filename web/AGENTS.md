# Web development

React 19, Vite, strict TypeScript, HeroUI v3 only. Keep every component's default appearance.

Allowed `className`: static standard Tailwind layout utilities for responsive breakpoints, placement, spacing, size, overflow, grid and flex. Forbidden: custom CSS/SCSS, CSS Modules, inline styles, CSS-in-JS, themes, CSS variables, arbitrary Tailwind values, and utilities that change color, typography, border, radius, shadow or animation. `src/styles.css` contains only the Tailwind and HeroUI imports. Do not modify the checker to permit a visual override.

Use HeroUI controls, feedback, cards, typography and navigation elements. Native file inputs/media are permitted for underlying browser capabilities. Render document/model text safely; no raw HTML injection. Run `npm run verify`; browser tests are in `e2e/` and expect the API and Vite to be running against a disposable database.
