# GA Estimated Revenue

Chrome extension (Manifest V3) that adds two metric cards to the Google Analytics 4
metric row: **Est. revenue = Views ÷ divisor** (formatted as GBP) and **Est. rev next
month**, that revenue multiplied by how fast views are growing.

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
3. Click **Load unpacked** (top-left) and select this folder.
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
