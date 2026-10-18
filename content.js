/* GA Estimated Revenue — injects two metric cards after Views:
   1. Est. revenue: Views ÷ divisor. The divisor scales linearly with the selected
      date range: 500 per 28 days => 250 over 14 days, 1000 over 8 weeks.
   2. Views MoM: GA's own period-over-period delta for Views, normalised to a
      28-day "month" by compounding: (1 + r)^(28 / days) − 1. */
(() => {
  'use strict';

  const MARK = 'data-ga-est-revenue';
  const MOM_MARK = 'data-ga-views-mom';
  const MONTH_DAYS = 28;
  const MIN_MOM_DAYS = 7;          // shorter ranges compound noise into nonsense
  const MOM_LABEL = 'Views MoM';
  const DEFAULTS = { divisor: 500, baseDays: 28, currency: '£', label: 'Est. revenue' };
  let cfg = { ...DEFAULTS };

  // Accept the metric under any of GA's naming variants.
  const VIEW_LABELS = /^(views|page ?views|screen ?page ?views)$/i;

  /* ---------- value parsing ---------- */

  // "16K" -> 16000 | "2.2K" -> 2200 | "1.4M" -> 1400000 | "16,432" -> 16432
  function parseMetricValue(text) {
    if (!text) return null;
    const m = String(text).trim().replace(/,/g, '').match(/^([\d.]+)\s*([KMB])?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return n * mult;
  }

  function formatMoney(value) {
    return cfg.currency + Math.round(value).toLocaleString('en-GB');
  }

  // "+12.3%" | "−4.0%"; "≈" marks a figure normalised from a non-28-day range.
  function formatPct(ratio, approx) {
    const pct = Math.abs(ratio * 100);
    const digits = pct >= 100 ? 0 : 1;
    const body = pct.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return `${approx ? '≈ ' : ''}${ratio < 0 ? '−' : '+'}${body}%`;
  }

  /* ---------- Views delta (period over period) ---------- */

  const DOWN_HINT = /arrow[_-]?down|downward|decrease|negative|unfavou?rable|trending[_-]down/i;
  const UP_HINT = /arrow[_-]?up|upward|increase|positive|favou?rable|trending[_-]up/i;

  // GA's delta under Views, e.g. "↑ 12.3%", as a signed ratio (0.123). Null when there
  // is no comparison or the direction can't be read — fail safe, never guess a sign.
  function readViewsDelta(metricTab) {
    const delta = metricTab.querySelector('.delta');
    if (!delta) return null;
    const icons = [...delta.querySelectorAll('mat-icon, .delta-icon, svg')];
    const bare = delta.cloneNode(true);             // text without ligature icon names
    bare.querySelectorAll('mat-icon, .delta-icon, svg').forEach((n) => n.remove());
    const text = bare.textContent;
    const m = /([-−–]?)\s*([\d,]+(?:\.\d+)?)\s*%/.exec(text);
    if (!m) return null;
    const pct = parseFloat(m[2].replace(/,/g, ''));
    if (!Number.isFinite(pct)) return null;
    if (pct === 0) return 0;

    let sign = m[1] ? -1 : 0;
    if (!sign) {
      // Direction lives in the arrow icon and/or the delta's classes / labels.
      const hints = [delta, ...icons].map((n) => [
        n.getAttribute('class'), n.getAttribute('aria-label'), n.getAttribute('fonticon'),
        n.getAttribute('svgicon'), n.getAttribute('data-mat-icon-name'),
        n.tagName === 'MAT-ICON' ? n.textContent : '',
      ].join(' ')).join(' ');
      if (DOWN_HINT.test(hints)) sign = -1;           // before UP: "unfavorable" contains "favorable"
      else if (UP_HINT.test(hints) || /\u2191/.test(text)) sign = 1;
      else if (/\u2193/.test(text)) sign = -1;
    }
    return sign ? sign * pct / 100 : null;
  }

  /* ---------- date range detection ---------- */

  const DAY = 864e5;

  function parseYmd(s) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function inclusiveDays(startMs, endMs) {
    if (startMs === null || endMs === null || endMs < startMs) return null;
    const n = Math.round((endMs - startMs) / DAY) + 1;
    return n >= 1 && n <= 3660 ? n : null;
  }

  // GA4 carries the range in the hash as _u.date00 / _u.date01 (YYYYMMDD),
  // usually URI-encoded once or twice inside the params blob.
  function periodFromHash() {
    let hash = location.hash || '';
    for (let i = 0; i < 2; i++) {
      try { hash = decodeURIComponent(hash); } catch (e) { break; }
    }
    const a = /_u\.date00=(\d{8})/.exec(hash);
    const b = /_u\.date01=(\d{8})/.exec(hash);
    if (!a || !b) return null;
    return inclusiveDays(parseYmd(a[1]), parseYmd(b[1]));
  }

  const RELATIVE = [
    [/last\s+(\d+)\s+days?/i, (m) => +m[1]],
    [/last\s+(\d+)\s+weeks?/i, (m) => +m[1] * 7],
    [/last\s+(\d+)\s+months?/i, (m) => +m[1] * 30],
    [/last\s+(\d+)\s+years?/i, (m) => +m[1] * 365],
    [/\blast\s+week\b/i, () => 7],
    [/\bthis\s+week\b/i, () => 7],
    [/\blast\s+month\b/i, () => 30],
    [/\bthis\s+month\b/i, () => 30],
    [/\blast\s+year\b/i, () => 365],
    [/\b(yesterday|today)\b/i, () => 1],
  ];

  // "Aug 1 - Aug 28, 2025" / "1 Aug 2025 – 28 Aug 2025"
  const TEXT_RANGE = /([A-Za-z]{3,9}\.?\s+\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\.?)(?:,?\s*(\d{4}))?\s*[-–—]\s*([A-Za-z]{3,9}\.?\s+\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\.?)(?:,?\s*(\d{4}))?/;

  function periodFromText(text) {
    for (const [re, toDays] of RELATIVE) {
      const m = re.exec(text);
      if (m) {
        const d = toDays(m);
        if (d >= 1 && d <= 3660) return d;
      }
    }
    const r = TEXT_RANGE.exec(text);
    if (r) {
      const endYear = r[4] || r[2];
      const startYear = r[2] || r[4];
      if (endYear) {
        const s = Date.parse(`${r[1]} ${startYear} UTC`);
        const e = Date.parse(`${r[3]} ${endYear} UTC`);
        if (Number.isFinite(s) && Number.isFinite(e)) return inclusiveDays(s, e);
      }
    }
    return null;
  }

  const PICKER_SELECTORS = [
    'ga-date-picker', 'ga-date-range-picker', 'ga-date-range',
    '[class*="date-range"]', '[class*="daterange"]', '[class*="date-picker"]',
    '[aria-label*="date range" i]', '[aria-label*="Date range"]',
  ].join(',');

  function periodFromPicker() {
    let nodes;
    try { nodes = document.querySelectorAll(PICKER_SELECTORS); } catch (e) { return null; }
    for (const el of nodes) {
      const text = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`
        .replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) continue;
      const days = periodFromText(text);
      if (days) return days;
    }
    return null;
  }

  // The delta is only month-on-month if GA compares against the preceding period.
  // Home doesn't put a comparison range in the hash (it defaults to the preceding
  // period); a comparison that isn't adjacent (e.g. "same period last year") is.
  function comparesPreviousPeriod() {
    let hash = location.hash || '';
    for (let i = 0; i < 2; i++) {
      try { hash = decodeURIComponent(hash); } catch (e) { break; }
    }
    const start = /_u\.date00=(\d{8})/.exec(hash);
    const cmpEnd = /_u\.date11=(\d{8})/.exec(hash);
    if (!start || !cmpEnd) return true;
    return parseYmd(start[1]) - parseYmd(cmpEnd[1]) === DAY;
  }

  // Days in the range currently on screen; falls back to the configured base.
  function detectPeriodDays() {
    return periodFromHash() || periodFromPicker() || cfg.baseDays;
  }

  // 500 views per £1 over 28 days, scaled to however long the range actually is.
  function divisorFor(periodDays) {
    const base = Math.max(1, Number(cfg.baseDays) || DEFAULTS.baseDays);
    const per = Math.max(1, Number(cfg.divisor) || DEFAULTS.divisor);
    return per * (periodDays / base);
  }

  /* ---------- source lookup ---------- */

  // Find the visible Views tab and the .mat-mdc-tab wrapper that is its real "card".
  function findSource() {
    for (const metricTab of document.querySelectorAll('ga-metric-tab')) {
      if (metricTab.closest(`[${MARK}], [${MOM_MARK}]`)) continue;   // skip our own clones
      const label = metricTab.querySelector('.picker span')?.textContent.trim() || '';
      if (!VIEW_LABELS.test(label)) continue;
      if (!metricTab.querySelector('.value')) continue;
      const host = metricTab.closest('.mat-mdc-tab');
      if (!host || !host.parentElement) continue;
      if (host.getBoundingClientRect().width === 0) continue;  // hidden duplicate
      return { metricTab, host };
    }
    return null;
  }

  /* ---------- card construction ---------- */

  function buildCard(host, mark, label, value, color) {
    const card = host.cloneNode(true);   // cloneNode drops event listeners — the card is inert
    card.setAttribute(mark, '');

    // Strip every trace of "this tab is selected"
    [...card.classList]
      .filter((c) => c.includes('--active') || c.includes('--selected'))
      .forEach((c) => card.classList.remove(c));
    card.querySelectorAll('[class*="--active"]').forEach((el) => {
      [...el.classList].filter((c) => c.includes('--active')).forEach((c) => el.classList.remove(c));
    });
    card.querySelector('ga-metric-tab')?.classList.remove('selected');
    card.querySelectorAll('.mdc-tab-indicator__content, .mat-mdc-tab-ripple, .mat-ripple')
      .forEach((el) => el.remove());

    // Accessibility + interactivity: present but not announced as a tab
    card.removeAttribute('role');
    card.removeAttribute('aria-selected');
    card.removeAttribute('tabindex');
    card.setAttribute('aria-hidden', 'true');
    card.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    card.querySelectorAll('mat-icon').forEach((el) => el.remove());   // caret + delta arrow

    // Label
    const labelSpan = card.querySelector('.picker span');
    if (labelSpan) labelSpan.textContent = label;

    // Value
    const valueSpan = card.querySelector('.value span') || card.querySelector('.value');
    if (valueSpan) {
      valueSpan.textContent = value;
      if (color) valueSpan.style.color = color;
    }

    // No subtitle: drop the delta row entirely (no formula, no % change)
    card.querySelector('.delta')?.remove();

    return card;
  }

  /* ---------- render ---------- */

  const GREEN = '#137333';
  const RED = '#c5221f';
  const lastSignatures = {};

  // Swap a card in place (keeps its slot), or insert it after `after` / at the end.
  function place(mark, card, labels, after) {
    const existing = document.querySelector(`[${mark}]`);
    if (existing && existing.parentElement === labels) { existing.replaceWith(card); return; }
    existing?.remove();
    if (after && after.parentElement === labels) after.after(card);
    else labels.appendChild(card);
  }

  // Build/refresh one card; spec null removes it.
  function renderCard(mark, src, spec, after) {
    const existing = document.querySelector(`[${mark}]`);
    if (!spec) {
      existing?.remove();
      lastSignatures[mark] = null;
      return null;
    }
    // Skip a rebuild if nothing relevant changed (prevents flicker)
    if (existing && existing.isConnected && spec.signature === lastSignatures[mark]) return existing;
    const card = buildCard(src.host, mark, spec.label, spec.value, spec.color);
    place(mark, card, src.host.parentElement, after);
    lastSignatures[mark] = spec.signature;
    return card;
  }

  function revenueSpec(src, periodDays) {
    const rawViews = src.metricTab.querySelector('.value')?.textContent.trim();
    const views = parseMetricValue(rawViews);
    if (views === null) return null;
    const divisor = divisorFor(periodDays);
    return {
      label: cfg.label,
      value: formatMoney(views / divisor),
      signature: [rawViews, divisor, cfg.currency, cfg.label].join('|'),
    };
  }

  function momSpec(src, periodDays) {
    if (periodDays < MIN_MOM_DAYS || !comparesPreviousPeriod()) return null;
    const r = readViewsDelta(src.metricTab);
    if (r === null || r <= -1) return null;
    const mom = periodDays === MONTH_DAYS ? r : (1 + r) ** (MONTH_DAYS / periodDays) - 1;
    return {
      label: MOM_LABEL,
      value: formatPct(mom, periodDays !== MONTH_DAYS),
      color: mom > 0 ? GREEN : mom < 0 ? RED : null,
      signature: [r, periodDays].join('|'),
    };
  }

  function render() {
    const src = findSource();
    if (!src) {                       // Views not on screen (user swapped the metric)
      renderCard(MARK, null, null);
      renderCard(MOM_MARK, null, null);
      return;
    }
    const periodDays = detectPeriodDays();
    const revenue = renderCard(MARK, src, revenueSpec(src, periodDays), null);   // end of the row
    renderCard(MOM_MARK, src, momSpec(src, periodDays), revenue);
  }

  /* ---------- observe GA's re-renders ---------- */

  let scheduled = false;
  const observer = new MutationObserver(() => schedule());

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; safeRender(); }, 250);
  }

  function safeRender() {
    observer.disconnect();                       // don't observe our own writes
    try { render(); } catch (err) { /* never break the host page */ }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /* ---------- boot ---------- */

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    cfg = { ...DEFAULTS, ...stored };
    safeRender();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) cfg[k] = newValue;
    for (const k of Object.keys(lastSignatures)) lastSignatures[k] = null;   // force rebuild
    safeRender();
  });

  // GA is a hash-routed SPA — the date range lives in the hash, so this also
  // catches range changes the observer might miss.
  window.addEventListener('hashchange', () => {
    for (const k of Object.keys(lastSignatures)) lastSignatures[k] = null;
    schedule();
  });
})();
