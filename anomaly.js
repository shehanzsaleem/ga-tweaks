/* GA Tweaks: which days of traffic to trust when estimating revenue.
   Pure: no DOM, no network, no chrome APIs. Runs in the page's MAIN world ahead of
   forecast.js, and in node for the tests (test/anomaly.test.js). */
(() => {
  'use strict';

  // Anomalous when a day's views per active user fall more than this far below the
  // range's median: that means users with no page views behind them, which earn nothing.
  const RATIO_DROP = 0.5;
  const MIN_RATIO_DAYS = 7;        // a median over fewer days is noise

  // Days known to be bot-affected, per GA property, as inclusive [from, to] ranges.
  // The ratio rule can't catch these alone: on 3 Nov 2026 it fell 39%, not 50%.
  const KNOWN_ANOMALIES = {
    263067478: [['2026-11-02', '2026-11-04']],
  };

  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Chart dates are midnight, UTC or local: noon lands on the right day either way.
  const dayKey = (ms) => new Date(ms + 43_200_000).toISOString().slice(0, 10);
  const dayLabel = (key) => `${key.slice(8)} ${MO[+key.slice(5, 7) - 1]}`;

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function isKnownAnomaly(propertyId, key) {
    return (KNOWN_ANOMALIES[propertyId] || []).some(([from, to]) => key >= from && key <= to);
  }

  /* views: [{date, value}] daily, oldest first. users: {dayKey: activeUsers}, may be partial.
     An anomalous day counts as a normal one: the median of the clean days, and never more
     than it really had. A low day caught by the ratio rule (real views, inflated users)
     keeps its views, so the adjusted figure can only come down. */
  function analyseDays(views, users = {}, propertyId = '') {
    const days = views.map((p) => {
      const key = dayKey(p.date);
      const activeUsers = Number.isFinite(users[key]) ? users[key] : null;
      return { key, views: p.value, users: activeUsers, ratio: activeUsers > 0 ? p.value / activeUsers : null };
    });

    const ratios = days.map((d) => d.ratio).filter((r) => r !== null);
    const medianRatio = ratios.length >= MIN_RATIO_DAYS ? median(ratios) : null;
    for (const d of days) {
      const low = medianRatio !== null && d.ratio !== null && d.ratio < medianRatio * (1 - RATIO_DROP);
      d.anomalous = low || isKnownAnomaly(propertyId, d.key);
    }

    const clean = days.filter((d) => !d.anomalous);
    const medianViews = median((clean.length ? clean : days).map((d) => d.views));
    for (const d of days) d.adjusted = d.anomalous ? Math.min(d.views, medianViews) : d.views;

    const flagged = days.filter((d) => d.anomalous);
    const sum = (field) => days.reduce((total, d) => total + d[field], 0);
    return {
      days: days.length,
      rawTotal: sum('views'),
      adjustedTotal: sum('adjusted'),
      flagged: flagged.map((d) => d.key),
      ...anomalyMessage(flagged, medianRatio),
    };
  }

  /* The badge. GA Home has no device data, so "users without device info" can't be read
     here; users beyond what the day's views explain is the same traffic seen from Home. */
  function anomalyMessage(flagged, medianRatio) {
    if (!flagged.length) return { message: null, detail: null };
    const detail = `Left out of the estimate and forecast: ${flagged.map((d) => dayLabel(d.key)).join(', ')}.`;
    const latest = flagged.at(-1);
    const excess = medianRatio && latest.users !== null
      ? Math.round((latest.users - latest.views / medianRatio) / 10) * 10
      : 0;
    if (excess > 0) {
      const count = excess.toLocaleString('en-GB');
      return { message: `Traffic anomaly: about ${count} users without page views on ${dayLabel(latest.key)}, likely server/bot events`, detail };
    }
    const noun = flagged.length === 1 ? 'day' : 'days';
    return { message: `Traffic anomaly: ${flagged.length} ${noun} left out of the estimate`, detail };
  }

  const api = { analyseDays, dayKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.__gaextAnomaly = api;
})();
