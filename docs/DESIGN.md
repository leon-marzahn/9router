# Design system — "warm workbench"

The dashboard's look and interaction rules. New UI code lives in `src/ui/` (TypeScript) and follows this doc. Older pages under `src/app/(dashboard)/` still use `src/shared/components/` and are migrated page by page.

## Principles

1. **Status first.** Every surface answers "is my routing healthy?" before anything else. Problems are pinned to the top and colored; healthy things are quiet.
2. **Work in place.** Prefer a list → detail workbench over navigating to a new page. Selecting an item shows its detail beside the list; the full page is one Enter away.
3. **Live by default.** Data that can change while the page is open updates itself (see *Live data*). Changes are announced with motion, never with layout jumps.
4. **One accent.** `#E56A4A` marks the primary action and the current location. If two things on screen are orange, one of them is wrong.
5. **Keyboard reachable.** Every list supports ↑/↓ (or j/k), `/` for search, Enter to open, Esc to go back.

## Tokens

Defined in `src/app/globals.css` (`:root` and `.dark`) and exposed as Tailwind utilities via `@theme inline`. **Never hard-code hex colors in components; use these.**

| Token | Use |
|---|---|
| `bg` | Canvas (page background) |
| `bg-alt` | Rail / sunken chrome |
| `pane` | List pane background |
| `surface` | Raised: panels, inputs, menus |
| `surface-2` / `surface-3` | Hover / pressed fills, segmented track |
| `border`, `border-subtle`, `border-strong` | Dividers, outlines (strong = inputs/secondary buttons in light mode) |
| `text`, `text-muted`, `text-subtle` | Primary, secondary, tertiary text |
| `accent`, `accent-hover`, `accent-fg` | Primary action, current location |
| `accent-soft`, `accent-ring`, `accent-text` | Selected row fill / ring / text on soft fill |
| `inverse`, `inverse-fg` | Tooltips, high-emphasis secondary buttons |
| `success`, `warning`, `danger`, `info`, `paused` (+ `-text`, `danger-soft`, `danger-border`) | Status only — see below |

Legacy names (`primary`, `text-main`, `brand-*`) are aliases kept for old pages; don't use them in new code.

Dark mode is the `.dark` class on `<html>` (set by `useTheme`). Write `dark:` variants only when a token can't express the difference.

### Type

- **Display** `font-display` (system serif: New York / Iowan / Georgia) — page titles, overview headlines, empty-state headings. Regular weight, `tracking-tight`.
- **UI** `font-sans` (Inter) — everything else. Base size 13px; secondary 12px (`text-xs`); meta 11px.
- **Mono** `font-mono` — ids, codes (`429`, `AUTH`), URLs, commands, keys.
- Numbers that update or align use `tabular-nums`.

### Shape & depth

- Radius: inputs/buttons/rows `rounded-lg`, panels `rounded-2xl`, tags `rounded`.
- Shadows: `shadow-soft` (resting panel), `shadow-elevated` (hover lift), `shadow-elev` (menus, toasts, dialogs), `shadow-warm` (primary button only), `shadow-focus` (focus ring).

## Status

One vocabulary for everything with health (`src/ui/status.ts`):

| Status | Meaning | Dot |
|---|---|---|
| `ok` | Working | success |
| `degraded` | Some accounts failing, still routing | warning |
| `error` | Not routing | danger |
| `paused` | Turned off by the user | paused |
| `ready` | Works without setup (no-auth) | info |
| `none` | Not configured | hollow ring |
| `pending` | Being checked | pulsing |

Sort problem-first with `STATUS_ORDER`. Show it with `StatusDot` / `StatusLabel`; error codes with `<Tag tone="danger" mono>429</Tag>`.

## App frame (`src/ui/frame/`)

```
┌────┬──────────────────────────────────────────────┐
│rail│ Title   [page KPI strip…]   [search][actions] │ ← TopBar (h-12)
│    ├──────────────────────────────────────────────┤
│ 9  │                                              │
│ ▣  │   page content                               │
│ ▣  │   (padded, max-w-7xl — or full-bleed panes)  │
│ …  │                                              │
│ ☾ ⚙│                                              │
└────┴──────────────────────────────────────────────┘
```

- **Rail** (`Rail.tsx`, md+): logo, nav groups from `nav.ts` (labels in tooltips), Media flyout, update indicator, theme toggle, account menu (settings, language, changelog, donate, external links, shutdown, logout). Below `md` it becomes a labeled drawer (`MobileNav.tsx`) opened from the top bar.
- **TopBar**: title from `pageMeta.ts` (or breadcrumbs). Pages add to it with portals:
  ```jsx
  <TopBarContent><InlineStat value={10} label="live" /></TopBarContent>
  <TopBarActions><Button icon="monitor_heart">Health check</Button></TopBarActions>
  ```
  The header search (`useHeaderSearchStore`) still works and renders before the actions.
- **Content**: padded & centered by default. Workbench pages that own their panes are listed in `isFullBleed` (`nav.ts`).
- New nav entries go in `nav.ts`; new page titles in `pageMeta.ts`.

## Patterns

### Workbench (list → detail)
Fixed-width list pane (`w-[330px]`, `bg-pane`) with `SearchInput` + `Segmented` scope, `ListGroup`s ("Needs attention" first, `tone="danger"`), `ListRow`s. Detail pane scrolls independently. With nothing selected, the detail pane shows the page's **overview** (`StatGrid` + attention cards + live cards). Esc returns to it.

### Overview
`font-display` headline + one-sentence summary ("**10 providers** and **39 healthy accounts** in rotation · 2 need attention"), then `StatGrid`, then "Needs attention" (danger-tinted panels with *Re-test* / *Inspect*), then everything healthy.

### Forms
`Field` + `Input`/`Segmented`. Primary action left-most, `variant="primary"`; a secondary "Test first" where an action can be verified. Inline in the detail pane rather than in modals where possible.

### Empty states
`EmptyState` with an icon, one sentence that says what to do, and the action.

## Live data

- Pages subscribe to server-sent events (the pattern `UsageStats` already uses with `/api/usage/stream`) instead of polling.
- A changed row flashes: pass a primitive `version` (e.g. `` `${status}:${connected}/${total}` ``) to `ListRow`, or use `useFlashOnChange` + `animate-live-flash` yourself.
- Changing numbers count to their new value with `LiveNumber` (used by `StatGrid` / `InlineStat`).
- In-flight things get `<StatusDot live />` (ping ring).
- All motion is disabled under `prefers-reduced-motion`.
- **Security:** event streams sit behind dashboard auth, carry status data only (never tokens, keys, or raw upstream error bodies), and cap concurrent connections.

## Components (`src/ui/index.ts`)

`Button` / `IconButton` (primary · secondary · ghost · inverse · danger), `Switch`, `Field` / `Input` / `SearchInput` / `Kbd`, `Segmented`, `StatusDot` / `StatusLabel`, `Tag`, `Panel` / `SectionTitle` / `Eyebrow` / `EmptyState`, `StatGrid` / `InlineStat`, `ListRow` / `ListGroup`, `Popover` / `MenuItem`, `ProviderLogo`, `LiveNumber`, `useFlashOnChange`, `cn` (tailwind-merge).

Rules: icon-only buttons always get a `label`; switches always get a `label`; don't nest panels; one primary button per view.
