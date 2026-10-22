# GA Tweaks

**Google Analytics 4, on steroids.** A small Chrome extension that makes GA4 more useful
day to day: revenue estimates next to your Views, a forecast on the Views chart, and a
compact layout that uses your whole screen instead of a narrow column with wide margins.

- **Est. revenue** card: Views ÷ a rate you set (500 views per £1 over 28 days by
  default), right beside GA's own Views card.
- **Est. rev next month** card: that estimate multiplied by how fast views are growing.
- **Views forecast**: estimated revenue in the Views chart tooltip, plus a *Prediction*
  toggle that draws a 28-day projection after the selected range.
- **Compact layout**: about a third of GA's padding, and cards, charts, carousels and the
  Explore landing stretched to the full window width. Toggle with **Alt+C** or the
  checkbox in the toolbar popup.

Everything runs locally in your browser. The extension makes no network requests, sends
no data anywhere, and only asks for the `storage` permission (to keep your settings). It
only runs on `analytics.google.com`, and it never changes your GA data, reports or
exports: it's display only.

Contributions are welcome — see [Contributing](#contributing).

## Est. revenue card

The divisor scales linearly with the date range on screen — 500 views per £1 over
28 days, so 14 days divides by 250 and 8 weeks (56 days) by 1000. With 16K views over
28 days the card reads `£32`, sitting to the right of Views and styled identically to
GA's native cards (it's a clone of the Views tab). No subtitle under the value.

## Est. rev next month card

Sits right of Est. revenue. It takes GA's own delta under Views (the "↑ 157.5%" comparing
the range with the preceding period of the same length), turns it into a multiplier and
applies it to this month's estimate:

- **Factor** = `1 + r`, so ↑ 157.5% is ×2.58 and ↓ 20% is ×0.80.
- **Value** = Est. revenue × factor, shown with the factor, e.g. `£82 (×2.58)` from `£32`.
- **28-day range** (Home's default "Last 28 days"): the factor is used as-is. Any other
  range of 7+ days is compounded to 28 days: `(1 + r)^(28 / days)`.
- Green when the factor is above 1, red below. Hidden when there's no comparison, the
  range is under 7 days, the direction arrow can't be read, or the comparison isn't the
  preceding period (e.g. "same period last year", detected from `_u.date10/11` in the URL).

## Install

1. Open `chrome://extensions`.
2. Toggle **Developer mode** ON (top-right).
3. Click **Load unpacked** (top-left) and select this folder (clone it first:
   `git clone https://github.com/shehanzsaleem/ga-tweaks.git`).
4. Open or hard-refresh <https://analytics.google.com/analytics/web/> (Ctrl/Cmd + Shift + R).
   Content scripts only inject on page load, so an already-open tab must be reloaded.

After any code edit: reload the extension on `chrome://extensions` (↻ icon), **then**
hard-refresh the Analytics tab. Both steps are required.

## Settings

Click the toolbar icon to change the card label, currency symbol, and the base rate —
*views per unit* over *how many days* (500 / 28 by default). Stored in
`chrome.storage.sync`; changes apply without a page reload.

## How it works

- Finds the `ga-metric-tab` whose label matches Views / Page views / Screen page views,
  climbs to its `.mat-mdc-tab` wrapper, clones it, and appends the clone to
  `.mat-mdc-tab-labels`.
- The clone has all `--active` / `selected` classes and the blue indicator stripped, and
  is inert (`pointer-events: none`, `aria-hidden`) — `cloneNode` carries no listeners.
- The period length comes from `_u.date00` / `_u.date01` in the URL hash, falling back to
  parsing the date-picker text ("Last 28 days", "Aug 1 - Aug 28, 2025"), then to the
  configured base. The divisor is then `perUnit × (periodDays ÷ baseDays)`.
- A debounced `MutationObserver` plus a `hashchange` listener re-render on date-range
  changes and SPA navigation; the card removes itself if Views leaves the row.

## Views chart: revenue tooltip + prediction (`forecast.js`)

A second content script runs in the page's **MAIN world** (Chrome 111+) so it can read
the D3-bound `__data__` on the Home card's Views chart (exact daily values, not "25K").

- **Tooltip row** — hovering the Views line adds *Est. monthly revenue* =
  daily views × 28 ÷ 250 (GBP, 2 dp) under GA's own Views row. Daily granularity only.
- **Prediction toggle** — a *Prediction* button beside the "Last 28 days" picker in the
  card footer. When on, GA's plot is hidden (CSS class on `ga-tab-chart`) and an overlay
  SVG redraws history, the dashed previous period and a 28-day projection (shaded band,
  faded line, hollow hover dots, "Projected" tooltip). Turning it off removes the overlay
  and GA's chart is untouched. Disabled for non-Views metrics, hourly/weekly/monthly
  ranges, or fewer than 5 days. The state lasts for the tab session (`sessionStorage`).
- The projection is a mean-reverting random walk in log space anchored on the last
  7 days, seeded from property + range end + total views, so it's stable across redraws.
  A range ending today leaves the partial last day out of the model. It's illustrative,
  not a forecast.
- It never touches the date-range picker, GA's network calls or GA's chart data.

## Compact layout (`compact.js` + `compact.css`)

Every rule is scoped under `html.ga-compact`, so switching it off restores GA's own look.
The on/off choice is remembered in GA's `localStorage` (key `gaCompact`, on by default)
and other open GA tabs follow it. It runs at `document_start` so there's no flash of the
roomy layout.

### What it changes

| Element | GA default | Compact |
|---|---|---|
| `.ga-report-header` | `20px 40px 10px` | `6px 12px` |
| `.report-controls` | margin `0 28px` | `0 8px` |
| `.report-title-section` | `18px 0 8px` | `8px 0 6px` |
| `.main-layout` | `24px 40px 40px 32px`, margin-top 46px | `8px 12px 12px`, margin-top = header height |
| `ga-card`, `gold-insights-card-wrapper` gaps | 24px | 8px (16px between cards in a list or grid, see Spacing) |
| `.tab-contents` | `0 24px` | `0 8px` |
| `xap-card-content.card-content` | `24px 24px 0` | `8px 8px 0` |
| `xap-card-footer.card-footer` | padding-left 24px | 8px, no fixed height |
| Table rows (plain `<table>` and Material tables) | GA's | 4px cell padding, 36px Material rows; font size unchanged |

### Header offset

`compact.js` finds the visible `.ga-report-header` and the outermost
fixed or absolute box between it and `.main-layout`. A ResizeObserver feeds that box's height
into `--gac-header-h`, which becomes main-layout's margin-top, so nothing sits under the
header. On pages without a report header (Home), GA's own offset is left alone.

### Full width

GA sizes each card in px from a 160px column grid (306 / 466 / 626 / 1106px), written
inline on the inner `xap-card`. Widening the outer wrapper alone left those widths fixed,
which is what left a gap in the middle of Home. So:

- **Card lists** (Home, Reports snapshot, detail reports, Realtime): `compact.js` copies
  each card's intended width (inline `xap-card` width + 14px) into `--gaext-w`, and the
  cards flex-grow by it, so a wide card stays wide and a small one stays small while both
  fill the row. The inner `xap-card` fills its slot. The list is capped at 100% so a chart
  can't push it wider than the screen.
- **Detail reports**: the anomaly / insights banner (inline 1120px) stretches.
- **Carousels** (Recently accessed, Suggested for you, Insights): wrapping grids of
  ≥320px tiles, 16px apart, scroll arrows hidden.
- **Explore landing**: no 1100px centred column; templates are a grid of ≥200px tiles
  and the saved explorations list is full width.

**Spacing.** GA spaces cards with a 7px margin on the inner card, which at full width
pushed each card 14px into its neighbour. Those margins are removed and the containers
own all spacing from one scale at the top of `compact.css`: `--gaext-gap` (16px between
cards, across and down), `--gaext-section` (32px above a section heading) and
`--gaext-head` (12px between a heading and its cards). Change those three to make it
tighter or roomier.

These selectors (`ga-card-list`, `ga-horizontal-fade`, `vero-template-picker`,
`saved-analysis-list-m2`, …) came from inspecting live GA and are internal, so they're the
first thing to check if a section stops behaving after a Google update.

Anything else that caps a card's width is found by walking up from each card and
un-capped:

- a px `max-width` that is binding → `max-width: none`
- a block narrower than its parent (fixed width, or auto-centred) → `width: auto`
- fixed-width items in a flex row with spare room → they grow in proportion to their widths
- a grid of px columns with spare room → the same columns as fractions

Each find is logged once in the DevTools console as
`[GA Compact] un-capped div.some-container — max-width 1280px`. The containers above are
skipped, since the CSS lays them out itself.

The scan re-runs as GA swaps views (DOM, inline-style and hash changes, throttled to
~3×/s) and on window resize, then fires a `resize` event so GA's charts redraw at the new
width.

## Limitations

- GA only exposes the abbreviated value (`16K`), never the exact count, so the figure is
  a genuine estimate (±£1 at 500 views/unit) and is rounded to whole pounds.
- Selectors (`ga-metric-tab`, `.picker span`, `.value`, `.delta`, `.mat-mdc-tab-labels`)
  are internal Google class names and can change without notice. The clone approach fails
  safe: it stops appearing rather than showing a wrong number.
- Value and date-range parsing assume an English GA UI (K/M/B suffixes, `,` thousands
  separator, "Last N days").
- "Last N months" is treated as N × 30 days; a custom range read from the hash is exact.
- Below ~1200px viewport width the 6-card row may crowd or wrap.
- The growth sign comes from GA's delta arrow (icon name / `favorable` class). If Google
  changes that markup the card hides rather than guess.
- Cosmetic and local only — never appears in exports, scheduled emails, or shared reports.
- Compact layout: the left nav rail isn't narrowed yet; it needs a look at its live markup
  so the content pane doesn't end up with a gap or an overlap.


## Contributing

Issues and pull requests are welcome: bug reports, fixes for GA markup changes, new
tweaks, or support for other locales and currencies.

- There's no build step. Edit the files, click ↻ on the extension in `chrome://extensions`,
  then reload the Analytics tab.
- GA4 is an Angular app whose internal class and tag names change without notice. When
  something stops working, the selectors are the first thing to check; please say which
  GA page and what you saw.
- Keep features failing safe: if the markup isn't what you expect, show nothing rather
  than a wrong number or a broken layout.
- Keep it local: no network requests, analytics or new permissions.
- Each feature lives in its own file (`content.js` for the cards, `forecast.js` for the
  chart, `compact.js`/`compact.css` for the layout); match the surrounding style.

## License

[MIT](LICENSE)
