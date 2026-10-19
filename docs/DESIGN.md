# Design system — "warm workbench"

The dashboard of **Elizabeth's Proxy**. The mark is a crowned serif E on the accent tile (`Logo` in `src/ui/Logo.tsx`; `public/favicon.svg` and `public/icons/*` are generated from the same paths).

The dashboard's look and interaction rules. New UI code lives in `src/ui/` (TypeScript) and follows this doc. Older pages under `src/app/(dashboard)/` still use `src/shared/components/` and are migrated page by page.

## Principles

1. **Status first.** Every surface answers "is my routing healthy?" before anything else. Problems are pinned to the top and colored; healthy things are quiet.
2. **Work in place.** Prefer a list → detail workbench over navigating to a new page. Selecting an item shows its detail beside the list; the full page is one Enter away.
3. **Live by default.** Data that can change while the page is open updates itself (see *Live data*). Changes are announced with motion, never with layout jumps.
4. **One accent.** Dusty rose (`#A84D68`; `#E596AD` in dark) marks the primary action and the current location. If two things on screen are rose, one of them is wrong.
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
- Buttons put their icon **after** the label, on every variant, so a row of buttons reads label-first and lines up. The primary button is a dusty-rose pill (`rounded-full`) whose icon sits in a round chip: the action's own icon (`add` to create, `play_arrow` to test, `save`, …), or `arrow_forward` when it moves you on. Secondary/ghost/danger stay `rounded-lg` with a plain trailing icon. Label contrast ≥ 4.5:1 in both themes (5.4:1 light, 7.96:1 dark).
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

Each pattern below names its canonical form. Where a page does something else, it's a known divergence, tracked in the design-audit follow-ups; don't copy it.

### Page layout
- **Workbench pages** (list → detail) are full-bleed: add the route to `isFullBleed` in `nav.ts` and own both panes.
- **Single-pane pages** sit in the padded frame with `mx-auto` and one of two widths: `max-w-3xl` for settings-style forms (Settings, Token Saver, Skills) and `max-w-7xl` for dashboards and tools (Usage, Console Log, Translator, Endpoint).
- **Page header** for single-pane pages: `h1` `font-display text-3xl tracking-tight`, then `p mt-1 text-sm text-text-muted` with one sentence. Workbench pages skip it; their title is the TopBar.
- Page-wide actions (Clear, Copy all, Health check) go in `TopBarActions`; live/connection state goes in `TopBarContent` as `<StatusDot live />` + "Live" / "Reconnecting".

### Workbench (list → detail)
- **List pane:** `md:w-[330px] shrink-0 border-r border-border bg-pane`, full width below `md`.
- **List header:** `SearchInput` (shortcut `/`), then an optional `Segmented` scope (e.g. In use / All, All / Needs attention). A "New" action is a `Button size="sm"` beside the search.
- **List body:** `ListGroup`s, with "Needs attention" first and `tone="danger"`, holding `ListRow`s. Don't hand-roll row buttons or uppercase group headers: `ListRow` already gives the selected fill/ring and the live flash. A dashed "Add …" row at the end of a group is fine.
- **Loading:** `ListSkeleton` from `src/ui`.
- **Keyboard:** ↑/↓ and j/k move the selection, `/` focuses search, Esc clears the selection and returns to the overview.
- **Mobile (< md):** list *or* detail, never stacked. When something is selected the list gets `hidden md:flex`, and the detail starts with a ghost back button: `← All <things>`, 13px with a 16px `arrow_back` icon, at `px-4 pt-4`.
- **Overview on mobile:** desktop shows the overview with nothing selected, which mobile can't (it shows the list). So the list starts with `WorkbenchOverviewRow` (hidden on md+), which opens the overview as its own screen at `?view=overview`. Treat that view as an open detail: pass `detailOpen={!!sel || overview}` to both `WorkbenchList` and `WorkbenchDetail` (keep `selected={sel}` on the list), so the list hides and the overview gets the same back button; selecting anything (or going back) drops `view`. Desktop never sets it.
- **Detail header:** a logo tile (`ProviderLogo`, 56px) or icon, the name in `font-display text-3xl` (mono only for ids users type, e.g. combo names, at the same size), and a meta row (`StatusLabel`, kind, `Tag`s, mono id). Controls (routing `Switch`, `IconButton`s, More `Popover`) sit on the right. Headers scroll with the content; none are sticky.
- **Nothing selected:** the page's **Overview** (below). If a page has no overview yet, show `EmptyState`, not a custom icon + sentence block.

Build it from the shell rather than re-creating the panes and the key listener:

```tsx
useListKeyboard({ order, selected: sel, onSelect: select, searchRef, onEnter });

<div className="flex min-h-0 flex-1">
  <WorkbenchList
    selected={sel}
    header={<SearchInput ref={searchRef} shortcut="/" … />}
    hints={[["↑↓", "move"], ["/", "search"], ["esc", "overview"]]}
  >
    {loading ? <ListSkeleton /> : groups.map((g) => <ListGroup …>{/* ListRows */}</ListGroup>)}
  </WorkbenchList>
  <WorkbenchDetail detailOpen={!!sel} backLabel="All providers" onBack={() => select(null)}>
    {current ? <Detail … /> : <Overview … />}
  </WorkbenchDetail>
</div>
```

- `WorkbenchList` is the 330px pane (header `space-y-2 p-3`, scrolling body, `Kbd` hint footer on md+); it hides itself on mobile while `detailOpen` (default: `selected` is set) and scrolls the `ListRow` whose id equals `selected` into view.
- `WorkbenchDetail` is the overview/detail pane with the mobile back button.
- `useListKeyboard` takes row ids in display order. It ignores keys while a modal is open, and inside a field only Esc (blur) works. `onEnter` is optional (Providers opens the full page).

### Kind switch
- Use `Segmented` when the options fit in one row (≤ 5 short labels).
- Media Providers' `KindSwitch` (a 3-column grid of radio tiles, for 10 kinds) is the sanctioned exception for many kinds; it sits above the search in the list header.
- Never build tab bars from `Panel` + buttons (Translator's step picker is a known divergence).

### Overview
`font-display` headline + one-sentence summary ("**10 providers** and **39 healthy accounts** in rotation · 2 need attention"), then `StatGrid`, then "Needs attention" (danger-tinted panels with *Re-test* / *Inspect*), then everything healthy. Pages whose overview is a different kind of thing keep the headline + summary and swap the body: Quota (reset timeline + capacity cards), Request Pipelines (an "applies to" routing table).

### Sections
- Inside a page, group content as `SettingsSection` (an `h2` `font-display text-xl` with an icon, over a `Panel divide-y px-5`) when the section is a list of rows.
- Use `SectionTitle` above free-form `Panel`s.
- Don't add a third heading style.

### Settings rows
`SettingRow` (title, hint, control on the right; `stack` puts the control below), with `SettingRowSkeleton` while loading and `Note` (success/warning/danger with an icon) for the result of an action. Used by Settings and Token Saver.

### Status chips
- Health goes through `StatusDot` / `StatusLabel` with a `Status` value; don't keep a local `DOT` map of color classes.
- `Tag` is for facts (kind, apiType, error codes, counts); use `tone` only for status meaning.

### Copy
- `CopyButton` (an icon that turns into a check for 1.2s) is the only copy control. Put it after the value it copies; the value goes in `font-mono`.
- For a copyable command or URL line: `flex items-center gap-1 rounded-lg bg-bg-alt px-3 py-1.5 font-mono text-[12px]` with the value, then a `CopyButton`.

### Code blocks
Use `CodeBlock` (`<pre>` in a `Panel overflow-hidden`, `text` or `children` as the body, `copy` for the header `CopyButton`), with an optional header strip (`border-b px-4 py-1.5 text-[12px] text-text-muted`: language on the left, `CopyButton` on the right), and a body of `overflow-x-auto p-4 font-mono text-[12px] leading-relaxed`. Sunken code inside a panel uses `bg-bg-alt`, not `bg-surface-2`.

### Drawers & dialogs
- **Drawer:** Usage's `RequestDrawer` is the reference: a right-side `aside role="dialog"`, `top-12` under the TopBar, `w-[min(560px,100vw)] border-l shadow-elev`, full-screen below `md`. Its header has prev (k) / next (j) / close (Esc) `IconButton`s.
- **Dialogs:** `Dialog` and `ConfirmDialog` from `@/ui`. A centered `rounded-2xl` card (`size` `sm`–`xl`) on md+, a bottom sheet with full-width stacked buttons below `md`. They trap Tab, close on Esc / scrim / ×, lock page scroll, return focus to the trigger, and label the `role="dialog"` with the title (and `description`). Pass `dismissible={false}` while a request is in flight. `ConfirmDialog` (`title`, `message`, `confirmText`, `variant` `danger` default / `primary`, `confirmIcon`, `loading`) focuses Cancel first so a stray Enter never confirms, and can't be dismissed while `loading`. Prefer inline editing in the detail pane; use a dialog for confirmations and short single-field prompts (Combos' name dialog is the reference).
- **Scrim:** `bg-scrim` (token `--color-scrim`) behind dialogs and the mobile nav drawer; never `bg-black/…`.
- **Model picker:** `ModelSelectModal` from `@/shared/components` (typed, no cast needed) is built on `Dialog`. Dialogs can stack (a picker opened from a dialog): only the top one handles Esc / Tab.
- Legacy `Modal` / `ConfirmModal` from `@/shared/components` are only left on pages not redesigned yet (Pxpipe, the per-tool CLI detail route) and the upstream modals they open; don't add new usages.

### Forms
- `Field` + `Input`/`Segmented`. Inline in the detail pane rather than in modals where possible.
- The primary action goes left-most, `variant="primary"`. Add a secondary "Test first" where an action can be verified.
- Button icons render **after** the label whatever prop you pass (`icon` or `trailingIcon`).

### Empty states
- `EmptyState` with an icon, one sentence that says what to do, and the action.
- An empty *filtered list* may be a single muted line (`px-2.5 py-6 text-center text-[12px] text-text-muted`).

### Type sizes in practice
Use the scale from *Type* above: 13px base, `text-xs`, and 11px meta. The `text-[11px]` / `text-[12px]` / `text-[13px]` literals are accepted spellings of it. Other one-off pixel values (`mt-[22px]`, `h-[19px]`) are not: align with flex/grid instead.

## Live data

- Pages subscribe to server-sent events (the pattern `UsageStats` already uses with `/api/usage/stream`) instead of polling.
- A changed row flashes: pass a primitive `version` (e.g. `` `${status}:${connected}/${total}` ``) to `ListRow`, or use `useFlashOnChange` + `animate-live-flash` yourself.
- Changing numbers count to their new value with `LiveNumber` (used by `StatGrid` / `InlineStat`).
- In-flight things get `<StatusDot live />` (ping ring).
- All motion is disabled under `prefers-reduced-motion`.
- **Security:** event streams sit behind dashboard auth, carry status data only (never tokens, keys, or raw upstream error bodies), and cap concurrent connections.

## Components (`src/ui/index.ts`)

`Button` / `IconButton` (primary · secondary · ghost · inverse · danger), `Switch`, `Field` / `Input` / `Select` / `SearchInput` / `Kbd`, `Segmented`, `StatusDot` / `StatusLabel`, `Tag`, `Panel` / `SectionTitle` / `Eyebrow` / `EmptyState`, `SettingsSection` / `SettingRow` / `SettingRowSkeleton` / `Note`, `StatGrid` / `InlineStat`, `ListRow` / `ListGroup`, `WorkbenchList` / `WorkbenchDetail` / `useListKeyboard`, `Skeleton` / `ListSkeleton`, `CopyButton`, `CodeBlock`, `Popover` / `MenuItem`, `ProviderLogo`, `LiveNumber`, `useFlashOnChange`, `cn` (tailwind-merge).

Rules: icon-only buttons always get a `label`; switches always get a `label`; don't nest panels; one primary button per view.
