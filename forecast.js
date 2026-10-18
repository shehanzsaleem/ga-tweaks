/* GA Estimated Revenue — Views chart extras on the Home overview card:
   1. "Est. monthly revenue" row in the chart tooltip (daily views × 28 ÷ 250).
   2. A "Prediction" toggle that overlays a seeded 28-day random-walk projection.
   Runs in the page's MAIN world: D3's bound __data__ expandos aren't visible from
   the isolated content-script world. GA's own chart nodes are never mutated —
   in prediction mode GA's plot is hidden with a class and ours is drawn on top. */
(() => {
  'use strict';

  if (window.__gaextForecast) return;
  window.__gaextForecast = true;

  /* ---------- shared helpers ---------- */

  const LOG = '[gaext]';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DAY_MS = 86_400_000;
  const REVENUE_DAYS = 28;
  const VIEWS_PER_POUND = 250;
  const CURRENCY = 'GBP';                       // matches the existing "£" Est. revenue tile
  const PROJECTION_DAYS = 28;

  const ROW = 'data-ga-est-revenue-row';
  const TOGGLE = 'data-ga-prediction-toggle';
  const LAYER = 'data-ga-forecast-layer';
  const ON_CLASS = 'gaext-prediction-on';
  const STORE_KEY = 'gaext-prediction';

  const BLUE = '#1a73e8';
  const VIEW_KEYS = /^(views|page ?views|screen ?page ?views)$/i;

  const fmtViews = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
  const fmtMoney = new Intl.NumberFormat('en-GB', { style: 'currency', currency: CURRENCY, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = new Intl.NumberFormat('en-GB', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const monthlyRevenue = (dailyViews) => dailyViews * REVENUE_DAYS / VIEWS_PER_POUND;   // 1,357 → 151.984 → "£151.98"

  // Built by hand: Intl en-GB says "Sept", GA says "Sep".
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDay = (ms) => { const d = new Date(ms); return `${WD[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')} ${MO[d.getUTCMonth()]}`; };

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function readViewsChart() {
    const tabChart = document.querySelector('ga-tab-chart');
    const svg = tabChart?.querySelector('ga-line-chart > svg');
    if (!svg) return null;
    const root = svg.querySelector(':scope > g.chart-root');
    const hoverRect = root?.querySelector(':scope > rect.hover-rect');
    if (!root || !hoverRect) return null;
    const lines = [...root.querySelectorAll(':scope > g.chart-group > path.line')];
    const curEl = lines.find((p) => !p.hasAttribute('stroke-dasharray'));
    const prevEl = lines.find((p) => p.hasAttribute('stroke-dasharray'));
    const cur = curEl?.__data__;
    if (!cur || !VIEW_KEYS.test(String(cur.key || '')) || !Array.isArray(cur.points) || cur.points.length < 2) return null;
    const toPts = (arr) => arr.map((p) => ({ date: +p.date, value: Math.max(0, +p.value || 0) }));
    const points = toPts(cur.points);
    const prevPoints = Array.isArray(prevEl?.__data__?.points) ? toPts(prevEl.__data__.points) : null;
    const isDaily = points.every((p, i) => i === 0 || Math.abs(p.date - points[i - 1].date - DAY_MS) <= 3_600_000);
    const m = root.transform.baseVal.consolidate()?.matrix;
    return {
      tabChart, svg, root, points, prevPoints, isDaily, key: String(cur.key),
      plotW: +hoverRect.getAttribute('width'), plotH: +hoverRect.getAttribute('height'),
      originX: m ? m.e : 5, originY: m ? m.f : 5,
      svgW: +svg.getAttribute('width'), svgH: +svg.getAttribute('height'),
      label: svg.querySelector('.legend-entry.dimension-legend text.label')?.textContent.trim() || 'Selected range',
    };
  }

  function ineligibleReason(chart) {
    if (!chart) return 'Prediction is only available for the Views metric';
    if (!chart.isDaily) return 'Prediction needs a daily date range (not hourly, weekly or monthly)';
    if (chart.points.length < 5) return 'Prediction needs at least 5 days of data';
    if (!(chart.plotW > 0 && chart.plotH > 0)) return 'Chart is not ready yet';
    return null;
  }

  /* ---------- projection model ---------- */

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

  // If the range ends TODAY (This week / This month / …), the last point is a partial
  // day: leave it out of the model, but still plot it as history.
  function modelSlice(history) {
    const now = new Date();
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return history.at(-1).date >= todayUtc ? history.slice(0, -1) : history;
  }

  function projectionSeed(history) {
    const values = modelSlice(history).map((p) => p.value);
    const propertyId = (location.hash.match(/p(\d+)/) || [])[1] || '';
    return `${propertyId}|${history.at(-1).date}|${values.reduce((a, b) => a + b, 0)}`;
  }

  // Mean-reverting (OU-style) random walk in log space, anchored on the recent
  // 7-day level with a small damped trend. Deterministic per dataset.
  function projectViews(history /* [{date,value}] daily, oldest→newest */, seed, horizon = PROJECTION_DAYS) {
    const values = modelSlice(history).map((p) => p.value);
    const logs = values.map((v) => Math.log(v + 1));
    const rec = logs.slice(-Math.min(14, logs.length));
    const rets = rec.slice(1).map((x, i) => x - rec[i]);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
    const sigma = clamp(sd * 0.75, 0.04, 0.22);                              // daily log-volatility
    const n = rec.length, xm = (n - 1) / 2, ym = rec.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0; rec.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) ** 2; });
    const drift = clamp(0.25 * (den ? num / den : 0), -0.005, 0.005);       // ≤ ±0.5%/day, damped trend
    const last7 = values.slice(-7);
    const anchor = Math.log(last7.reduce((a, b) => a + b, 0) / last7.length + 1);
    const theta = 0.25;                                                     // pull back toward the anchor each day
    const rng = mulberry32(hashStr(seed));
    const gauss = () => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    let x = logs.at(-1);
    const lastDate = history.at(-1).date;
    const out = [];
    for (let t = 1; t <= horizon; t++) {
      const target = anchor + drift * t;
      x = clamp(x + theta * (target - x) + sigma * gauss(), target - Math.log(2), target + Math.log(2));
      out.push({ date: lastDate + t * DAY_MS, value: Math.max(0, Math.round(Math.exp(x) - 1)), projected: true });
    }
    return out;
  }

  let projCache = { seed: null, value: null };
  function getProjection(history) {
    const seed = projectionSeed(history);
    if (projCache.seed !== seed) projCache = { seed, value: projectViews(history, seed) };
    return projCache.value;
  }

  /* ---------- styles ---------- */

  const CSS = `
[${TOGGLE}].gaext-prediction-toggle{display:inline-flex;align-items:center;vertical-align:top;height:36px;min-width:0;margin:0 0 0 8px;padding:0 8px;border-radius:4px;background:transparent;color:#202124;font:400 13px/36px "Google Sans",Roboto,Arial,sans-serif;letter-spacing:.15px;cursor:pointer;border:0}
[${TOGGLE}].gaext-prediction-toggle.gaext-prediction-toggle--footer{margin-right:auto}
[${TOGGLE}].gaext-prediction-toggle:hover{background:rgba(32,33,36,.04)}
[${TOGGLE}].gaext-prediction-toggle:focus-visible{outline:2px solid #1a73e8;outline-offset:1px}
[${TOGGLE}] .gaext-prediction-label-wrap{display:inline-flex;align-items:center;white-space:nowrap}
[${TOGGLE}] .gaext-prediction-icon{font-size:18px;margin-right:6px;color:#5f6368;vertical-align:middle}
[${TOGGLE}].gaext-prediction-toggle[aria-pressed="true"]{background:rgba(26,115,232,.08);color:#1a73e8}
[${TOGGLE}].gaext-prediction-toggle[aria-pressed="true"] .gaext-prediction-icon{color:#1a73e8}
[${TOGGLE}].gaext-prediction-toggle:disabled{opacity:.38;cursor:default;background:transparent}
ga-tab-chart.${ON_CLASS} ga-line-chart > svg > g.chart-root{visibility:hidden}
ga-tab-chart .body-chart{position:relative}
.gaext-forecast-layer{position:absolute;pointer-events:none;z-index:1}
.gaext-forecast-layer svg{display:block;overflow:visible}
.gaext-forecast-layer .gaext-hit{pointer-events:all;cursor:default}
.hover-card.gaext-hover-card{position:absolute;z-index:1000;pointer-events:none}
`;

  function ensureStyle() {
    if (document.getElementById('gaext-forecast-style')) return;
    const style = document.createElement('style');
    style.id = 'gaext-forecast-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------- state ---------- */

  let wanted = false;                              // user intent; survives metric switches
  try { wanted = sessionStorage.getItem(STORE_KEY) === '1'; } catch (e) { /* storage blocked */ }

  const setWanted = (on) => {
    wanted = on;
    try { sessionStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch (e) { /* storage blocked */ }
  };

  const isPredictionActive = () => !!document.querySelector(`ga-tab-chart.${ON_CLASS}`);

  // GA's delta arrow markup, learned from its own tooltips while prediction is off.
  const deltaCache = { up: null, down: null, downClass: null };

  /* ---------- feature 1: revenue row in GA's tooltip ---------- */

  function cacheDelta(card) {
    const delta = card.querySelector('.chart-hover-card .metric.selected:not([' + ROW + ']) .delta');
    const icon = delta?.querySelector('.delta-icon');
    if (!icon || !icon.innerHTML.trim()) return;
    if (delta.classList.contains('favorable')) {
      deltaCache.up ??= icon.innerHTML;
    } else {
      deltaCache.down ??= icon.innerHTML;
      deltaCache.downClass ??= [...delta.classList].find((c) => c !== 'delta') || null;
    }
  }

  // Index of the point GA is highlighting, cross-checked against the tooltip's date.
  function hoveredIndex(chart, card) {
    const hovers = chart.root.querySelectorAll('g.hover-group > g.hover');
    let idx = null;
    hovers.forEach((g, i) => {
      if (idx !== null) return;
      const visible = [...g.querySelectorAll(':scope > g.hover-point')].some((p) => p.style.visibility === 'visible');
      if (visible) idx = Number.isInteger(g.__data__?.index) ? g.__data__.index : i;
    });
    if (idx === null) return null;                 // tooltip belongs to another chart
    const title = card.querySelector('.title .date')?.textContent.trim() || '';
    const day = title.slice(0, 10);                // "Tue 22 Sep"
    if (chart.points[idx] && fmtDay(chart.points[idx].date) === day) return idx;
    const byDate = chart.points.findIndex((p) => fmtDay(p.date) === day);
    return byDate >= 0 ? byDate : (chart.points[idx] ? idx : null);
  }

  function augmentGaTooltip(card) {
    if (!card.isConnected || card.classList.contains('gaext-hover-card')) return;
    if (isPredictionActive()) return;
    const chart = readViewsChart();
    if (!chart || !chart.isDaily) return;

    const rows = [...card.querySelectorAll('.chart-hover-card .metric.selected')];
    const viewsRow = rows.find((r) => !r.hasAttribute(ROW));
    if (viewsRow?.querySelector('.name-text')?.textContent.trim() !== chart.key) return;

    cacheDelta(card);

    const index = hoveredIndex(chart, card);
    if (index === null) return;
    let views = chart.points[index]?.value;
    if (!Number.isFinite(views)) views = +(viewsRow.querySelector('.val')?.textContent || '').replace(/[^\d]/g, '');
    if (!Number.isFinite(views)) return;
    const money = fmtMoney.format(monthlyRevenue(views));

    // Idempotent: GA normally rebuilds the card per index, but update in place if not.
    const existing = card.querySelector(`[${ROW}]`);
    if (existing) {
      const val = existing.querySelector('.val');
      if (val && val.textContent !== money) val.textContent = money;
      if (existing.previousElementSibling !== viewsRow) viewsRow.after(existing);
      return;
    }

    const row = viewsRow.cloneNode(true);
    row.setAttribute(ROW, '');
    const name = row.querySelector('.name-text');
    if (name) name.textContent = 'Est. monthly revenue';
    const val = row.querySelector('.val');
    if (val) val.textContent = money;
    const delta = row.querySelector('.delta');
    if (delta) delta.style.visibility = 'hidden';   // keeps the value column aligned under Views
    viewsRow.after(row);
  }

  const cardObservers = new Map();

  function watchCard(card) {
    if (cardObservers.has(card) || card.classList.contains('gaext-hover-card')) return;
    const mo = new MutationObserver(() => {
      try { augmentGaTooltip(card); } catch (err) { console.error(LOG, err); }
    });
    mo.observe(card, { childList: true, subtree: true, characterData: true });
    cardObservers.set(card, mo);
    try { augmentGaTooltip(card); } catch (err) { console.error(LOG, err); }
  }

  function unwatchCard(card) {
    cardObservers.get(card)?.disconnect();
    cardObservers.delete(card);
  }

  const isHoverCard = (n) => n.nodeType === 1 && n.matches('div.hover-card');

  const hoverCardObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => { if (isHoverCard(n)) watchCard(n); });
      m.removedNodes.forEach((n) => { if (isHoverCard(n)) unwatchCard(n); });
    }
  });

  /* ---------- feature 2: prediction toggle ---------- */

  function buildToggle() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(TOGGLE, '');
    btn.setAttribute('aria-pressed', 'false');
    btn.className = 'mdc-button mat-mdc-button-base gmat-mdc-button mat-mdc-button mat-unthemed gaext-prediction-toggle';
    btn.innerHTML =
      '<span class="mdc-button__label gaext-prediction-label-wrap">' +
      '<span class="google-material-icons gaext-prediction-icon" aria-hidden="true">trending_up</span>' +
      '<span class="gaext-prediction-label">Prediction</span></span>';
    // Keep every event away from GA's footer / date-range picker handlers.
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup']) {
      btn.addEventListener(type, (e) => e.stopPropagation());
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      setWanted(!wanted);
      sync();
    });
    return btn;
  }

  function ensureToggle(tabChart) {
    const card = tabChart.closest('xap-card') || tabChart.closest('ga-card');
    const footer = card?.querySelector('xap-card-footer');
    const selector = footer?.querySelector('ga-date-range-selector');
    const picker = selector?.querySelector('ga-date-range-picker-v2');
    const anchor = picker || selector;

    let btn = null;
    document.querySelectorAll(`[${TOGGLE}]`).forEach((b) => {
      if (!btn && anchor && footer.contains(b)) btn = b; else b.remove();
    });
    if (!anchor) { btn?.remove(); return null; }

    btn ??= buildToggle();
    btn.classList.toggle('gaext-prediction-toggle--footer', !picker);
    if (btn.previousElementSibling !== anchor || !btn.isConnected) anchor.after(btn);
    return btn;
  }

  function updateToggle(btn, reason, on) {
    const setAttr = (k, v) => { if (btn.getAttribute(k) !== v) btn.setAttribute(k, v); };
    if (btn.disabled !== !!reason) btn.disabled = !!reason;
    setAttr('aria-pressed', on ? 'true' : 'false');
    setAttr('title', reason || `Show a ${PROJECTION_DAYS}-day projection after the selected range (doesn't change the date range)`);
    const label = btn.querySelector('.gaext-prediction-label');
    const text = on ? `Prediction · next ${PROJECTION_DAYS} days` : 'Prediction';
    if (label && label.textContent !== text) label.textContent = text;
  }

  /* ---------- overlay drawing ---------- */

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, v);
    parent?.appendChild(node);
    return node;
  }

  function textStyle(node) {
    const cs = getComputedStyle(node);
    return `fill:${cs.fill};font-size:${cs.fontSize};font-family:${cs.fontFamily};font-weight:${cs.fontWeight}`;
  }

  // Copy GA's axis geometry/typography so our axes are indistinguishable from its own.
  function readAxisStyle(root, plotW) {
    const s = {
      xText: 'fill:#5f6368;font-size:12px;font-family:Roboto,"Helvetica Neue",sans-serif',
      xTick: 'rgba(0,0,0,.08)', xTickY2: '6', xTextY: '9', ddDy: '7', monDy: '12',
      firstAnchor: 'start', anchor: 'middle',
      yText: null, yOffset: 4, yTickX2: '30', yTickStroke: null,
      yTextX: '33', yTextDy: '.32em', yTextTransform: 'translate(-2,8)', yAnchor: 'end',
    };
    const xTexts = root.querySelectorAll('g.x-axis g.tick text');
    if (xTexts[0]) {
      s.xText = textStyle(xTexts[0]);
      s.xTextY = xTexts[0].getAttribute('y') ?? s.xTextY;
      const sp = xTexts[0].querySelectorAll('tspan');
      s.ddDy = sp[0]?.getAttribute('dy') ?? s.ddDy;
      s.monDy = sp[1]?.getAttribute('dy') ?? s.monDy;
      s.firstAnchor = getComputedStyle(xTexts[0]).textAnchor || s.firstAnchor;
    }
    if (xTexts[1]) s.anchor = getComputedStyle(xTexts[1]).textAnchor || s.anchor;
    const xLine = root.querySelector('g.x-axis g.tick line');
    if (xLine) { s.xTick = getComputedStyle(xLine).stroke; s.xTickY2 = xLine.getAttribute('y2') ?? s.xTickY2; }

    const yAxis = root.querySelector(':scope > g.y-axis');
    const ym = yAxis?.transform.baseVal.consolidate()?.matrix;
    if (ym && Number.isFinite(ym.e - plotW)) s.yOffset = ym.e - plotW;
    const yLine = yAxis?.querySelector('g.tick line');
    if (yLine) { s.yTickX2 = yLine.getAttribute('x2') ?? s.yTickX2; s.yTickStroke = getComputedStyle(yLine).stroke; }
    const yText = yAxis?.querySelector('g.tick text');
    if (yText) {
      s.yText = textStyle(yText);
      s.yTextX = yText.getAttribute('x') ?? s.yTextX;
      s.yTextDy = yText.getAttribute('dy') ?? s.yTextDy;
      s.yTextTransform = yText.getAttribute('transform') ?? s.yTextTransform;
      s.yAnchor = getComputedStyle(yText).textAnchor || s.yAnchor;
    }
    s.yText ??= s.xText;
    return s;
  }

  function readLegend(svg) {
    const legend = svg.querySelector('g.legend');
    if (!legend) return null;
    try {
      const box = legend.getBBox();
      const m = svg.getScreenCTM()?.inverse().multiply(legend.getScreenCTM());
      if (!m) return null;
      const entry = legend.querySelector('.legend-entry.dimension-legend') || legend.querySelector('.legend-entry');
      const line = entry?.querySelector('line');
      const text = entry?.querySelector('text.label');
      const r = (n) => Math.round(n * 100) / 100;
      return {
        matrix: [m.a, m.b, m.c, m.d, m.e, m.f].map(r),
        x: r(box.x + box.width + 16),
        lineY: +(line?.getAttribute('y1') || 0),
        textX: text?.getAttribute('x') ?? '20',
        textY: text?.getAttribute('y') ?? null,
        textDy: text?.getAttribute('dy') ?? '.32em',
        textStyle: text ? textStyle(text) : 'fill:#5f6368;font-size:12px;font-family:Roboto,"Helvetica Neue",sans-serif',
      };
    } catch (e) {
      return null;                                  // not rendered (e.g. display:none)
    }
  }

  // Nice y-axis: step from {1, 2, 2.5, 5}·10^k giving at most 5 intervals.
  function niceTicks(max) {
    if (!(max > 0)) max = 1;
    for (let e = 0; e < 16; e++) {
      for (const m of [1, 2, 2.5, 5]) {
        const step = m * 10 ** e;
        const n = Math.ceil(max / step);
        if (n <= 5) return { ticks: Array.from({ length: n + 1 }, (_, i) => i * step), top: n * step };
      }
    }
    return { ticks: [0, max], top: max };
  }

  const fmtTick = (v) =>
    v >= 1e9 ? `${+(v / 1e9).toFixed(2)}B`
      : v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M`
        : v >= 1e3 ? `${+(v / 1e3).toFixed(2)}K`
          : String(v);

  const linePath = (pts) => pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join('');

  let overlay = null;   // { layer, sig }

  function teardownOverlay() {
    document.querySelectorAll(`ga-tab-chart.${ON_CLASS}`).forEach((t) => t.classList.remove(ON_CLASS));
    document.querySelectorAll(`[${LAYER}]`).forEach((n) => n.remove());   // takes its listeners with it
    document.querySelectorAll('.gaext-hover-card').forEach((n) => n.remove());
    overlay = null;
  }

  function renderOverlay(chart) {
    const body = chart.tabChart.querySelector('.body-chart');
    if (!body) { teardownOverlay(); return; }

    const projection = getProjection(chart.points);
    if (!chart.tabChart.classList.contains(ON_CLASS)) chart.tabChart.classList.add(ON_CLASS);

    let layer = body.querySelector(`:scope > [${LAYER}]`);
    document.querySelectorAll(`[${LAYER}]`).forEach((n) => { if (n !== layer) n.remove(); });
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'gaext-forecast-layer';
      layer.setAttribute(LAYER, '');
      body.appendChild(layer);
    }

    // Sit exactly on GA's SVG box (hidden plot still occupies its layout).
    const bodyRect = body.getBoundingClientRect();
    const svgRect = chart.svg.getBoundingClientRect();
    const pos = {
      left: `${Math.round((svgRect.left - bodyRect.left - body.clientLeft) * 100) / 100}px`,
      top: `${Math.round((svgRect.top - bodyRect.top - body.clientTop) * 100) / 100}px`,
      width: `${chart.svgW}px`,
      height: `${chart.svgH}px`,
    };
    for (const [k, v] of Object.entries(pos)) if (layer.style[k] !== v) layer.style[k] = v;

    const legend = readLegend(chart.svg);
    const sig = JSON.stringify([
      chart.points, chart.prevPoints, projCache.seed, chart.key,
      chart.plotW, chart.plotH, chart.originX, chart.originY, chart.svgW, chart.svgH, legend,
    ]);
    if (overlay && overlay.layer === layer && overlay.sig === sig && layer.firstChild) return;

    drawOverlay(layer, chart, projection, legend);
    overlay = { layer, sig };
  }

  function drawOverlay(layer, chart, proj, legend) {
    const { points: hist, prevPoints: prev, plotW, plotH } = chart;
    const all = hist.concat(proj);
    const N = all.length, H = hist.length;
    const step = plotW / (N - 1);
    const x = (i) => i * step;
    const prevN = prev ? Math.min(prev.length, H) : 0;

    let max = 0;
    for (const p of all) max = Math.max(max, p.value);
    for (let i = 0; i < prevN; i++) max = Math.max(max, prev[i].value);
    const { ticks, top } = niceTicks(max);
    const y = (v) => plotH - v / top * plotH;
    const ax = readAxisStyle(chart.root, plotW);

    layer.textContent = '';
    const svg = el('svg', { class: 'gaext-forecast-svg', width: chart.svgW, height: chart.svgH }, layer);
    const g = el('g', { transform: `translate(${chart.originX}, ${chart.originY})` }, svg);
    const xH = x(H - 1);

    // Projection band (behind everything else)
    el('rect', { x: xH, y: 0, width: Math.max(0, plotW - xH), height: plotH, fill: 'rgba(26,115,232,.06)' }, g);

    // Y grid + axis labels, mirroring GA's y-axis-grid-line / y-axis groups
    const grid = el('g', { class: 'gaext-y-grid' }, g);
    const yAxis = el('g', { class: 'gaext-y-axis', transform: `translate(${plotW + ax.yOffset}, 0)` }, g);
    for (const v of ticks) {
      el('line', { x1: 0, x2: plotW, y1: y(v), y2: y(v), stroke: 'rgba(0,0,0,.08)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, grid);
      const tick = el('g', { transform: `translate(0, ${y(v)})` }, yAxis);
      if (ax.yTickStroke && ax.yTickStroke !== 'none') el('line', { x2: ax.yTickX2, stroke: ax.yTickStroke, 'shape-rendering': 'crispEdges' }, tick);
      const t = el('text', { x: ax.yTextX, dy: ax.yTextDy, transform: ax.yTextTransform, 'text-anchor': ax.yAnchor, style: ax.yText }, tick);
      t.textContent = fmtTick(v);
    }

    // Previous period (dashed, history indices only), history, projection
    if (prevN > 1) {
      el('path', {
        d: linePath(prev.slice(0, prevN).map((p, i) => [x(i), y(p.value)])),
        fill: 'none', stroke: BLUE, 'stroke-width': 2, 'stroke-dasharray': '3, 3',
      }, g);
    }
    el('path', { d: linePath(hist.map((p, i) => [x(i), y(p.value)])), fill: 'none', stroke: BLUE, 'stroke-width': 2 }, g);
    el('path', {
      d: linePath(all.slice(H - 1).map((p, j) => [x(H - 1 + j), y(p.value)])),
      fill: 'none', stroke: BLUE, 'stroke-width': 2, 'stroke-opacity': 0.45,
    }, g);

    // Divider + "Projected" label
    el('line', { x1: xH, x2: xH, y1: 0, y2: plotH, stroke: 'rgba(0,0,0,.24)', 'stroke-dasharray': '2,2' }, g);
    el('text', { x: xH + 6, y: 12, style: 'fill:#5f6368;font-size:11px;font-family:Roboto,"Helvetica Neue",sans-serif' }, g)
      .textContent = 'Projected';

    // X axis: one tick per UTC Sunday across history + projection
    const xAxis = el('g', { class: 'gaext-x-axis', transform: `translate(0, ${plotH})` }, g);
    let lastMonth = null;
    all.forEach((p, i) => {
      const d = new Date(p.date);
      if (d.getUTCDay() !== 0) return;
      const first = lastMonth === null;
      const tick = el('g', { transform: `translate(${x(i)}, 0)` }, xAxis);
      el('line', { y2: ax.xTickY2, stroke: ax.xTick }, tick);
      const t = el('text', { y: ax.xTextY, 'text-anchor': first ? ax.firstAnchor : ax.anchor, style: ax.xText }, tick);
      el('tspan', { x: 0, dy: ax.ddDy }, t).textContent = String(d.getUTCDate()).padStart(2, '0');
      if (first || d.getUTCMonth() !== lastMonth) el('tspan', { x: 0, dy: ax.monDy }, t).textContent = MO[d.getUTCMonth()];
      lastMonth = d.getUTCMonth();
    });

    // Legend entry beside GA's legend row
    if (legend) {
      const lg = el('g', { class: 'gaext-legend', transform: `matrix(${legend.matrix.join(',')})`, 'pointer-events': 'none' }, svg);
      const entry = el('g', { transform: `translate(${legend.x}, 0)` }, lg);
      el('rect', { x: 1, y: legend.lineY - 5, width: 10, height: 10, fill: 'rgba(26,115,232,.12)' }, entry);
      el('line', { x1: 0, x2: 12, y1: legend.lineY, y2: legend.lineY, stroke: BLUE, 'stroke-width': 2, 'stroke-opacity': 0.45, 'stroke-linecap': 'round' }, entry);
      el('text', { x: legend.textX, y: legend.textY, dy: legend.textDy, style: legend.textStyle }, entry)
        .textContent = `Projection (next ${PROJECTION_DAYS} days)`;
    }

    // Hover affordances (pre-created, toggled on mousemove)
    const vline = el('line', { y1: 0, y2: plotH, stroke: 'rgba(0,0,0,.08)', 'stroke-width': 1, visibility: 'hidden' }, g);
    const dotPrev = el('circle', { r: 5, fill: BLUE, visibility: 'hidden' }, g);
    const dotHist = el('circle', { r: 5, fill: BLUE, visibility: 'hidden' }, g);
    const dotProj = el('circle', { r: 5, fill: '#fff', stroke: BLUE, 'stroke-width': 2, visibility: 'hidden' }, g);
    const hit = el('rect', { class: 'gaext-hit', x: 0, y: 0, width: plotW, height: plotH, fill: 'transparent' }, g);

    let current = -1;
    const hide = () => {
      current = -1;
      for (const n of [vline, dotPrev, dotHist, dotProj]) n.setAttribute('visibility', 'hidden');
      const card = document.querySelector('.gaext-hover-card');
      if (card) card.style.display = 'none';
    };

    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('mousemove', (evt) => {
      const r = hit.getBoundingClientRect();
      const mx = (evt.clientX - r.left) * (r.width ? plotW / r.width : 1);
      const i = clamp(Math.round(mx / step), 0, N - 1);
      const card = getHoverCard();
      if (i !== current) {
        current = i;
        const px = x(i);
        vline.setAttribute('x1', px); vline.setAttribute('x2', px); vline.setAttribute('visibility', 'visible');
        const isProj = i >= H;
        const place = (dot, v, show) => {
          dot.setAttribute('visibility', show ? 'visible' : 'hidden');
          if (show) { dot.setAttribute('cx', px); dot.setAttribute('cy', y(v)); }
        };
        place(dotHist, all[i].value, !isProj);
        place(dotProj, all[i].value, isProj);
        place(dotPrev, prev?.[i]?.value, !isProj && i < prevN);
        card.innerHTML = isProj
          ? projectedCardHtml(all[i], i - H + 1, proj.length)
          : historyCardHtml(chart.key, hist[i], i < prevN ? prev[i] : null, !!prev);
      }
      card.style.display = '';
      positionCard(card, evt);
    });
  }

  /* ---------- our tooltip (prediction on) ---------- */

  function getHoverCard() {
    let card = document.querySelector('body > .gaext-hover-card');
    if (!card) {
      card = document.createElement('div');
      card.className = 'hover-card gaext-hover-card';
      card.style.display = 'none';
      document.body.appendChild(card);
    }
    return card;
  }

  function positionCard(card, evt) {
    const gap = 16;
    const w = card.offsetWidth, h = card.offsetHeight;
    let left = evt.pageX + gap, top = evt.pageY + gap;
    if (evt.clientX + gap + w > document.documentElement.clientWidth) left = evt.pageX - gap - w;
    if (evt.clientY + gap + h > document.documentElement.clientHeight) top = evt.pageY - gap - h;
    card.style.left = `${Math.max(0, left)}px`;
    card.style.top = `${Math.max(0, top)}px`;
  }

  function deltaHtml(cur, prev) {
    if (!prev) return '<div class="delta"><span>-</span></div>';
    const r = (cur - prev) / prev;
    const up = r >= 0;
    const cls = up ? 'favorable' : (deltaCache.downClass || 'unfavorable');
    const icon = (up ? deltaCache.up : deltaCache.down) ?? (up ? '↑' : '↓');
    return `<div class="delta ${esc(cls)}"><span class="delta-icon">${icon}</span><span>${fmtPct.format(Math.abs(r))}</span></div>`;
  }

  const metricRow = (name, val, delta, extra = '') =>
    `<div class="metric selected"${extra}><div class="name"><span class="name-text">${esc(name)}</span></div>` +
    `<div class="val">${esc(val)}</div>${delta}</div>`;

  function historyCardHtml(key, p, pv, hasPrev) {
    const title = fmtDay(p.date) + (pv ? ` vs ${fmtDay(pv.date)}` : '');
    const delta = hasPrev ? deltaHtml(p.value, pv?.value ?? 0) : '';
    const hiddenDelta = delta.replace('<div class="delta', '<div style="visibility:hidden" class="delta');
    return '<div class="chart-hover-card hoverinfo"><div class="data">' +
      `<div class="title"><div class="date">${esc(title)}</div></div>` +
      metricRow(key, fmtViews.format(p.value), delta) +
      metricRow('Est. monthly revenue', fmtMoney.format(monthlyRevenue(p.value)), hiddenDelta, ` ${ROW}`) +
      '</div></div>';
  }

  function projectedCardHtml(p, day, total) {
    return '<div class="chart-hover-card hoverinfo"><div class="data">' +
      `<div class="title"><div class="date">${esc(`${fmtDay(p.date)} · Projected (day ${day} of ${total})`)}</div></div>` +
      metricRow('Projected views', fmtViews.format(p.value), '') +
      metricRow('Projected est. monthly revenue', fmtMoney.format(monthlyRevenue(p.value)), '', ` ${ROW}`) +
      '</div></div>';
  }

  /* ---------- lifecycle ---------- */

  let ro = null;
  let roTarget = null;

  function watchResize(tabChart) {
    const body = tabChart?.querySelector('.body-chart') || null;
    if (body === roTarget) return;
    ro ??= new ResizeObserver(() => schedule());
    if (roTarget) ro.unobserve(roTarget);
    if (body) ro.observe(body);
    roTarget = body;
  }

  function sync() {
    try {
      ensureStyle();
      const tabChart = document.querySelector('ga-tab-chart');
      watchResize(tabChart);
      if (!tabChart) {
        teardownOverlay();
        document.querySelectorAll(`[${TOGGLE}]`).forEach((b) => b.remove());
        return;
      }
      const chart = readViewsChart();
      const reason = ineligibleReason(chart);
      const on = wanted && !reason;
      const btn = ensureToggle(tabChart);
      if (btn) updateToggle(btn, reason, on);
      if (on) renderOverlay(chart); else teardownOverlay();
    } catch (err) {
      console.error(LOG, err);
    }
  }

  let rafId = 0;
  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; sync(); });
  }

  // Tooltip churn and our own overlay redraws don't need a sync pass.
  function isNoise(m) {
    if (m.target === document.body) {
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return nodes.length > 0 && nodes.every(isHoverCard);
    }
    const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    return !!target?.closest?.(`.hover-card, [${LAYER}]`);
  }

  const syncObserver = new MutationObserver((muts) => {
    if (!muts.every(isNoise)) schedule();
  });

  function boot() {
    document.querySelectorAll('body > div.hover-card').forEach(watchCard);
    hoverCardObserver.observe(document.body, { childList: true });
    syncObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', schedule);
    sync();
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
