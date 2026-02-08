# @cloudflare/agents-ui

Shared UI components, hooks, and theme CSS for Agents SDK examples and apps.

## Exports

| Import path                               | What it provides                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `@cloudflare/agents-ui`                   | React components (`ConnectionIndicator`, `ModeToggle`, `PoweredByAgents`, `CloudflareLogo`) |
| `@cloudflare/agents-ui/hooks`             | React hooks (`useTheme`) and `ThemeProvider`                                                |
| `@cloudflare/agents-ui/theme/workers.css` | Workers color theme CSS (Kumo custom properties)                                            |

## Usage

### Theme CSS (in your `styles.css`)

```css
@import "@cloudflare/agents-ui/theme/workers.css";
```

### Components

```tsx
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents
} from "@cloudflare/agents-ui";
```

### Hooks

```tsx
import { ThemeProvider, useTheme } from "@cloudflare/agents-ui/hooks";
```

Wrap your app in `<ThemeProvider>` to enable `useTheme` and `<ModeToggle>`.

## Notes

- This is a **private** workspace package — not published to npm.
- Source files are consumed directly via Vite (no build step).
- The theme CSS can be imported independently without React.
