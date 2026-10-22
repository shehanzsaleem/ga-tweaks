/* GA Compact — html.ga-compact switches compact.css on. This script:
   1. toggles the class (Alt+C or the popup) and remembers the choice in GA's localStorage;
   2. measures the fixed report header with a ResizeObserver so main-layout's margin-top
      follows its compact height (--gac-header-h);
   3. copies each card's intended px width (GA writes it inline on xap-card) into
      --gaext-w, so cards in a list grow in proportion to it;
   4. walks up from each card to find anything else that caps its width, marks it for
      compact.css to un-cap, and logs it to the console as "[GA Compact] un-capped …". */
(() => {
  'use strict';

  const CLS = 'ga-compact';
  const KEY = 'gaCompact';                 // '0' = off; missing or anything else = on
  const SEEDS = 'ga-card, .ga-card, gold-insights-card-wrapper, .main-layout';
  // Containers compact.css lays out itself; the cap walk leaves them and their children alone.
  const HANDLED = '.ga-card-list-content, ga-horizontal-fade .content-area, vero-template-picker ul.content-table';
  const CARD_PAD = 14;                     // GA's xap-card width = its slot width - 14px
  const SLACK = 2;                         // px of spare room put down to rounding
  const CENTRED_MARGIN = 48;               // equal side margins above this look like auto-centring
  const root = document.documentElement;

  /* ---------- toggle ---------- */

  function readPref() {
    try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
  }

  let on = readPref();

  function apply() {
    root.classList.toggle(CLS, on);
    if (on) schedule(true);
    window.dispatchEvent(new Event('resize'));   // GA's charts re-measure their boxes
  }

  function setOn(next) {
    on = next;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
    apply();
  }

  // Put the class back if the app ever rewrites <html class>.
  new MutationObserver(() => {
    if (on && !root.classList.contains(CLS)) root.classList.add(CLS);
  }).observe(root, { attributes: true, attributeFilter: ['class'] });

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat || e.code !== 'KeyC') return;
    // On macOS Alt+C types "ç"; leave text fields alone.
    const t = e.target;
    if (t instanceof Element && (t.isContentEditable || t.closest('input, textarea, select'))) return;
    e.preventDefault();
    setOn(!on);
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'gac:set') setOn(!!msg.on);
    if (msg?.type === 'gac:set' || msg?.type === 'gac:get') reply({ on });
  });

  // Keep other open GA tabs in step.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { on = readPref(); apply(); }
  });

  /* ---------- fixed header offset ---------- */

  const visible = (el) => el.getClientRects().length > 0;
  const firstVisible = (sel) => [...document.querySelectorAll(sel)].find(visible) || null;

  let header = null;
  let headerBox = null;   // the out-of-flow box over main-layout: the header or an ancestor
  const headerRO = new ResizeObserver(() => measureHeader());

  function trackHeader() {
    const h = firstVisible('.ga-report-header');
    const main = firstVisible('.main-layout');
    let box = null;
    if (h && main) {
      // Outermost fixed/absolute box between the header and the branch holding main-layout.
      for (let n = h; n && !n.contains(main); n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'absolute') box = n;
      }
    }
    if (h === header && box === headerBox) return;
    headerRO.disconnect();
    header = h;
    headerBox = box;
    if (box) headerRO.observe(box);
    measureHeader();
  }

  function measureHeader() {
    if (header?.isConnected) {
      // In-flow header: it already pushes main-layout down, so no extra offset.
      root.style.setProperty('--gac-header-h', (headerBox ? headerBox.offsetHeight : 0) + 'px');
      root.setAttribute('data-gac-header', '');
    } else {
      root.style.removeProperty('--gac-header-h');
      root.removeAttribute('data-gac-header');
    }
  }

  /* ---------- card widths ---------- */

  // GA keeps rewriting xap-card's inline width (306 / 466 / 626 / 1106px slots) even while
  // compact.css overrides it, so the inline value is always GA's intended width.
  function syncCardWidths() {
    let changed = false;
    for (const card of document.querySelectorAll('.ga-card-list-content > ga-card')) {
      const m = /width:\s*([\d.]+)px/.exec(card.querySelector('xap-card')?.getAttribute('style') || '');
      if (!m) continue;
      const w = String(Math.round(+m[1] + CARD_PAD));
      if (card.style.getPropertyValue('--gaext-w') !== w) {
        card.style.setProperty('--gaext-w', w);
        changed = true;
      }
    }
    return changed;
  }

  /* ---------- other width caps ---------- */

  const px = (v) => parseFloat(v) || 0;
  const walked = new WeakSet();   // seeds already checked (until the next full rescan)
  const logged = new WeakSet();

  function describe(el) {
    return el.tagName.toLowerCase() + [...el.classList].map((c) => '.' + c).join('');
  }

  function note(el, why) {
    if (logged.has(el)) return;
    logged.add(el);
    console.info('[GA Compact] un-capped', describe(el), '—', why, el);
  }

  function markCap(el, kind, why) {
    const cur = el.getAttribute('data-gac-unclamp');
    if (cur === kind || cur === 'width') return false;   // "width" already covers "max"
    el.setAttribute('data-gac-unclamp', kind);
    note(el, why);
    return true;
  }

  const contentWidth = (el, cs) => el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);

  const inFlow = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.position !== 'absolute' && s.position !== 'fixed';
  };

  // Block-level child narrower than its block parent: a fixed width or an auto-centred one.
  function checkBlock(node, cs, w, avail) {
    const ml = px(cs.marginLeft);
    const mr = px(cs.marginRight);
    const short = w + ml + mr < avail - SLACK;
    const centred = ml > CENTRED_MARGIN && Math.abs(ml - mr) <= 1;
    if (!short && !centred) return false;
    return markCap(node, 'width', `${Math.round(w)}px wide in ${Math.round(avail)}px`);
  }

  // Flex row whose items don't fill it and none of which grows: let them grow by width.
  function checkRow(row, ps, avail) {
    const kids = [...row.children].filter(inFlow);
    if (!kids.length) return false;
    if (kids.some((k) => px(getComputedStyle(k).flexGrow) > 0 && !k.hasAttribute('data-gac-grow'))) return false;

    const lines = new Map();   // wrapped rows are judged line by line
    for (const k of kids) {
      const key = ps.flexWrap === 'nowrap' ? 0 : Math.round(k.offsetTop);
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(k);
    }

    let changed = false;
    for (const line of lines.values()) {
      const gaps = px(ps.columnGap) * (line.length - 1);
      const used = line.reduce((sum, k) => {
        const s = getComputedStyle(k);
        return sum + k.getBoundingClientRect().width + px(s.marginLeft) + px(s.marginRight);
      }, gaps);
      if (avail - used <= SLACK) continue;
      for (const k of line) {
        if (k.hasAttribute('data-gac-grow')) continue;
        const w = Math.round(k.getBoundingClientRect().width);
        k.style.setProperty('--gac-grow', String(Math.max(w, 1)));
        k.setAttribute('data-gac-grow', '');
        note(k, `${w}px item in a ${Math.round(avail)}px row with ${Math.round(avail - used)}px spare`);
        changed = true;
      }
    }
    return changed;
  }

  // Grid of px tracks with spare room: same proportions as fractions.
  function checkGrid(grid, ps, avail) {
    if (grid.hasAttribute('data-gac-grid')) return false;
    const cols = ps.gridTemplateColumns;   // read before marking: ps is live
    const tracks = cols.split(' ').filter(Boolean);
    if (!tracks.length || !tracks.every((t) => t.endsWith('px'))) return false;
    const used = tracks.reduce((sum, t) => sum + px(t), px(ps.columnGap) * (tracks.length - 1));
    if (avail - used <= SLACK) return false;
    grid.style.setProperty('--gac-cols', tracks.map((t) => `minmax(0, ${px(t)}fr)`).join(' '));
    grid.setAttribute('data-gac-grid', '');
    note(grid, `grid columns ${cols} in ${Math.round(avail)}px`);
    return true;
  }

  function walk(seed) {
    let changed = false;
    for (let node = seed; node.parentElement && node !== document.body; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.position === 'fixed' || cs.position === 'absolute') break;   // overlay, not page flow
      const w = node.getBoundingClientRect().width;

      if (cs.maxWidth.endsWith('px') && w >= px(cs.maxWidth) - SLACK) {
        changed = markCap(node, 'max', `max-width ${cs.maxWidth}`) || changed;
      }

      const parent = node.parentElement;
      if (node.matches(HANDLED) || parent.matches(HANDLED)) continue;
      const ps = getComputedStyle(parent);
      const avail = contentWidth(parent, ps);
      if (ps.display.includes('grid')) {
        changed = checkGrid(parent, ps, avail) || changed;
      } else if (ps.display.includes('flex') && !ps.flexDirection.startsWith('column')) {
        changed = checkRow(parent, ps, avail) || changed;
      } else if (['block', 'flex', 'grid', 'flow-root'].includes(cs.display)) {
        changed = checkBlock(node, cs, w, avail) || changed;
      }
    }
    return changed;
  }

  /* ---------- scheduling (GA is an SPA: re-check as the DOM changes) ---------- */

  let timer = 0;
  let rescanAll = false;

  function schedule(all) {
    if (all) rescanAll = true;
    if (!timer) timer = setTimeout(run, 300);   // throttle: GA mutates the DOM constantly
  }

  function run() {
    timer = 0;
    trackHeader();
    if (!on) return;
    const all = rescanAll;
    rescanAll = false;
    let changed = syncCardWidths();
    for (const seed of document.querySelectorAll(SEEDS)) {
      if ((!all && walked.has(seed)) || !visible(seed)) continue;
      walked.add(seed);
      changed = walk(seed) || changed;
    }
    if (changed) window.dispatchEvent(new Event('resize'));
  }

  // Inline style changes matter too: that's where GA writes the card widths. Our own
  // --gaext-w writes on ga-card are skipped.
  new MutationObserver((records) => {
    if (records.some((r) => r.type === 'childList' || r.target.tagName !== 'GA-CARD')) schedule(false);
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  window.addEventListener('resize', () => schedule(true));
  window.addEventListener('hashchange', () => schedule(true));   // GA routes by hash

  apply();
})();
