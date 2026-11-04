/* Run with: node --test
   MONTH has the shape of a real month of daily [views, active users]: a dip in users'
   pages at the start, then a bot spike at the end that the ratio rule alone would miss.
   The figures are scaled, so nothing here is any site's real traffic. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyseDays, dayKey } = require('../anomaly.js');

const PROPERTY = '263067478';
const DAY = 86_400_000;
const at = (key) => Date.parse(`${key}T00:00:00Z`);

function series(start, rows) {
  const views = [];
  const users = {};
  rows.forEach(([v, u], i) => {
    const date = at(start) + i * DAY;
    views.push({ date, value: v });
    if (u !== undefined) users[dayKey(date)] = u;
  });
  return { views, users };
}

const MONTH = series('2026-10-07', [
  [251, 193], [238, 184], [264, 217], [618, 324], [489, 149], [683, 190], [633, 205],
  [822, 206], [761, 205], [518, 162], [539, 135], [697, 152], [883, 248], [955, 231],
  [835, 229], [783, 194], [806, 202], [711, 138], [549, 131], [927, 208], [868, 200],
  [792, 191], [734, 198], [658, 155], [582, 134], [774, 198], [1071, 276], [1433, 602],
]);

test('day keys land on the right day from UTC or local midnight', () => {
  assert.equal(dayKey(at('2026-11-03')), '2026-11-03');
  assert.equal(dayKey(at('2026-07-03') - 3_600_000), '2026-07-03');   // BST midnight
  assert.equal(dayKey(at('2026-11-03') + 5 * 3_600_000), '2026-11-03'); // US Eastern midnight
});

test('the known bot days are left out, and the ratio rule alone would miss 3 Nov', () => {
  const known = analyseDays(MONTH.views, MONTH.users, PROPERTY);
  assert.ok(known.flagged.includes('2026-11-02') && known.flagged.includes('2026-11-03'));
  const elsewhere = analyseDays(MONTH.views, MONTH.users, '111');
  assert.ok(!elsewhere.flagged.includes('2026-11-03'), 'another property has no known days');
});

test('the ratio rule flags a day whose views per user fall more than 50% below the median', () => {
  const { flagged } = analyseDays(MONTH.views, MONTH.users, '111');
  assert.deepEqual(flagged, ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
});

test('a day exactly at the 50% line is not flagged', () => {
  const rows = Array.from({ length: 9 }, () => [400, 100]);
  rows.push([200, 100]);
  const s = series('2026-01-01', rows);
  assert.deepEqual(analyseDays(s.views, s.users).flagged, []);
});

test('adjusting can only lower the figure, and low flagged days are not raised to the median', () => {
  const result = analyseDays(MONTH.views, MONTH.users, PROPERTY);
  assert.ok(result.adjustedTotal < result.rawTotal);
  // The spike comes down, but the low days at the start keep their views: replacing them
  // with the median would make a "bot-adjusted" estimate higher than the raw one.
  const octoberOnly = analyseDays(MONTH.views.slice(0, 20), MONTH.users, '111');
  assert.equal(octoberOnly.adjustedTotal, octoberOnly.rawTotal);
});

test('an inflated flagged day counts as the median of the clean days', () => {
  const rows = Array.from({ length: 9 }, () => [1000, 250]);
  rows.push([5000, 5000]);
  const s = series('2026-01-01', rows);
  const result = analyseDays(s.views, s.users);
  assert.deepEqual(result.flagged, ['2026-01-10']);
  assert.equal(result.rawTotal, 14000);
  assert.equal(result.adjustedTotal, 10000);
});

test('the badge states the users the day\'s views cannot explain', () => {
  const s = series('2026-10-08', [
    ...Array.from({ length: 27 }, () => [2000, 500]),
    [1000, 1500],
  ]);
  const { message, detail } = analyseDays(s.views, s.users, PROPERTY);
  assert.equal(message, 'Traffic anomaly: about 1,250 users without page views on 04 Nov, likely server/bot events');
  assert.match(detail, /02 Nov, 03 Nov, 04 Nov/);
});

test('with no user series the known days still apply, and the badge says so', () => {
  const result = analyseDays(MONTH.views, {}, PROPERTY);
  assert.deepEqual(result.flagged, ['2026-11-02', '2026-11-03']);
  assert.equal(result.message, 'Traffic anomaly: 2 days left out of the estimate');
});

test('too few days for a median means no ratio rule', () => {
  const s = series('2026-01-01', [[1000, 100], [1000, 100], [100, 1000]]);
  assert.deepEqual(analyseDays(s.views, s.users).flagged, []);
});

test('a clean range changes nothing and raises no badge', () => {
  const s = series('2026-01-01', Array.from({ length: 28 }, () => [1000, 250]));
  const result = analyseDays(s.views, s.users, PROPERTY);
  assert.equal(result.adjustedTotal, result.rawTotal);
  assert.equal(result.message, null);
  assert.equal(result.days, 28);
});

test('every day flagged still gives a finite answer', () => {
  const s = series('2026-11-02', [[1000, 250], [1200, 250], [800, 250]]);
  const result = analyseDays(s.views, s.users, PROPERTY);
  assert.equal(result.flagged.length, 3);
  assert.ok(Number.isFinite(result.adjustedTotal));
  assert.ok(result.adjustedTotal <= result.rawTotal);
});
