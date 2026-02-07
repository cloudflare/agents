# Visuals & UI

## Design system: Kumo

The playground (and eventually all examples) uses [Kumo](https://kumo-ui.com/), Cloudflare's internal design system (`@cloudflare/kumo`). It gives us semantic color tokens, accessible components, and automatic light/dark mode — all without maintaining our own component primitives.

### Setup

- **Package**: `@cloudflare/kumo` (installed at monorepo root as a devDependency)
- **Icons**: `@phosphor-icons/react` v2 (Kumo's peer icon library, also at root). Always use the `*Icon` suffixed exports (e.g. `TrashIcon`, `ShieldIcon`) — the bare names (`Trash`, `Shield`) are deprecated.
- **Shared UI**: `@cloudflare/agents-ui` (private workspace package at `packages/agents-ui/`) — ships the Workers color theme CSS, shared React components (`ConnectionIndicator`, `ModeToggle`), and hooks (`ThemeProvider`, `useTheme`)
- **Tailwind v4**: Requires `@tailwindcss/vite` in `vite.config.ts` (alongside `@vitejs/plugin-react` and `@cloudflare/vite-plugin`). Kumo ships its own Tailwind plugin; imported in `styles.css`:
  ```css
  @source "../../../node_modules/@cloudflare/kumo/dist/**/*.{js,jsx,ts,tsx}";
  @import "tailwindcss";
  @import "@cloudflare/kumo/styles/tailwind";
  @import "@cloudflare/agents-ui/theme/workers.css";
  ```
  Note: the `@source` path must point to the hoisted Kumo package at the monorepo root (`../../../node_modules`), not a local `node_modules`.

### Dark mode

Kumo uses a `data-mode` attribute on `<html>` (not Tailwind's `dark:` class variant). Our `useTheme` hook sets `document.documentElement.setAttribute("data-mode", resolved)`. All Kumo semantic tokens (`bg-kumo-base`, `text-kumo-default`, `border-kumo-line`, etc.) respond to this automatically — no `dark:` prefixes anywhere in the codebase.

### Color themes

Kumo supports theming via a `data-theme` attribute on a parent element. Themes override semantic token values while keeping the same token names, so components adapt automatically.

We ship a **Workers** theme (via `@cloudflare/agents-ui`) inspired by [workers.cloudflare.com](https://workers.cloudflare.com/):

- **Brand**: Cloudflare orange (`#f6821f`) for primary actions and links
- **Dark mode**: Deep navy-black surfaces (`#08090d` base) with subtle blue-tinted grays
- **Light mode**: Clean white base with crisp structural borders

The theme lives in `packages/agents-ui/src/theme/workers.css` and is consumed via:

```css
@import "@cloudflare/agents-ui/theme/workers.css";
```

Then set `data-theme="workers"` on `<html>`.

### Shared components and hooks

`@cloudflare/agents-ui` also exports React components and hooks used across all examples:

- **`ConnectionIndicator`** — a dot + label showing WebSocket connection status (`connecting`, `connected`, `disconnected`)
- **`ModeToggle`** — a button that cycles through system → light → dark theme modes
- **`PoweredByAgents`** — a "Powered by Cloudflare Agents" footer badge with the Cloudflare cloud glyph, linking to the Agents docs
- **`CloudflareLogo`** — the Cloudflare cloud glyph SVG in brand orange/yellow colors
- **`ThemeProvider` / `useTheme`** (from `@cloudflare/agents-ui/hooks`) — context provider and hook for managing light/dark/system mode, persisting the choice to `localStorage`

To switch back to Kumo's default theme, remove the `data-theme` attribute.

### Routing integration

Kumo's `<LinkProvider>` lets you inject a custom link component so `<Link>` renders via your router. However, there's a type mismatch between Kumo and React Router that requires an adapter.

**The problem:** Kumo's `LinkComponentProps` defines `to?: string` (optional), but React Router's `Link` requires `to: To` (non-optional, and `To = string | Partial<Path>`). These types aren't assignable in either direction — you can't pass `RouterLink` directly to `LinkProvider` without a type error.

**Our fix:** A thin `AppLink` adapter in `client.tsx` that bridges the two:

```tsx
const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(
  ({ to, ...props }, ref) => {
    if (to) {
      return <RouterLink ref={ref} to={to} {...props} />;
    }
    return <a ref={ref} {...props} />;
  }
);
```

This handles the optionality gap (falls back to `<a>` when `to` is absent) and narrows `To` to `string` which is all Kumo ever passes.

**Upstream fix:** Either Kumo should make `to` required in `LinkComponentProps` (it's always provided when the component is actually called), or accept `To` from React Router. Alternatively, React Router could loosen `Link` to accept `to?: string`. Worth raising with the Kumo team since every React Router user will hit this.

## Kumo components we use

| Kumo component          | Replaces                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `Button`                | All buttons (primary, secondary, destructive, ghost actions)                                          |
| `Input`                 | Text inputs; uses built-in `label` prop for Field wrapper                                             |
| `InputArea`             | Textareas                                                                                             |
| `Surface`               | Card/panel containers                                                                                 |
| `Text`                  | Headings and body text (note: does **not** accept `className` — wrap in a `<div>` for margin/spacing) |
| `Badge`                 | Status indicators and tags                                                                            |
| `Banner`                | Alert/warning banners                                                                                 |
| `CodeBlock`             | Static code examples and dynamic JSON display                                                         |
| `Tabs`                  | Tab switchers (e.g. inbox/outbox)                                                                     |
| `Switch`                | Boolean toggles (with built-in label)                                                                 |
| `Checkbox`              | Multi-select checkboxes                                                                               |
| `Table`                 | Data tables                                                                                           |
| `Empty`                 | Empty-state placeholders                                                                              |
| `Loader`                | Loading spinners                                                                                      |
| `LinkProvider` / `Link` | Router-aware links                                                                                    |

## What we do custom (and why)

### Sidebar category toggle

The sidebar nav uses a raw `<button>` to expand/collapse category sections. Kumo's `Collapsible` only accepts `label: string`, but our categories include icons alongside the text label.

### Routing strategy selector (RoutingDemo)

A custom radio-like selection UI with both a title and a description per option. Kumo's `Radio.Item` only supports `label: string` — no room for the per-option description we need.

### Interactive list items

Room lists (ChatRoomsDemo), table lists (SqlDemo), email lists (ReceiveDemo, SecureDemo), and preset buttons (ApprovalDemo) use raw `<button>` elements styled as list items. These are selection-driven list rows with complex active/hover states, not standard button patterns. Kumo doesn't have a selectable list component.

### Range slider (BasicDemo)

The workflow step-count slider uses a native `<input type="range">`. Kumo doesn't ship a range/slider component.

### Log panel

The event log (`LogPanel`) uses custom CSS utility classes (`.log-entry`, `.log-entry-in`, `.log-entry-out`, `.log-entry-error`) defined in `styles.css`. These are the only custom CSS classes in the codebase. They exist because log entries are a dense, domain-specific pattern with no Kumo equivalent.

### Semantic color token gaps

A few Kumo semantic tokens we expected don't exist (yet):

- `bg-kumo-success-tint` / `bg-kumo-success` — we fall back to `bg-green-500/10` / `bg-green-500`
- `border-l-kumo-success` — we fall back to `border-l-green-500`
- These raw Tailwind greens won't adapt to `data-theme` changes (they bypass the token system)

These should be replaced with proper Kumo tokens if/when they're added upstream.
