const DEFAULTS = { divisor: 500, baseDays: 28, currency: '£', label: 'Est. revenue' };

const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  $('divisor').value = cfg.divisor;
  $('baseDays').value = cfg.baseDays;
  $('currency').value = cfg.currency;
  $('label').value = cfg.label;
});

$('save').addEventListener('click', () => {
  const divisor = Math.max(1, parseInt($('divisor').value, 10) || DEFAULTS.divisor);
  const baseDays = Math.max(1, parseInt($('baseDays').value, 10) || DEFAULTS.baseDays);
  const currency = ($('currency').value || DEFAULTS.currency).trim() || DEFAULTS.currency;
  const label = ($('label').value || DEFAULTS.label).trim() || DEFAULTS.label;

  chrome.storage.sync.set({ divisor, baseDays, currency, label }, () => {
    $('divisor').value = divisor;
    $('baseDays').value = baseDays;
    $('saved').textContent = 'Saved';
    setTimeout(() => { $('saved').textContent = ''; }, 1500);
  });
});

/* ---------- compact layout (state lives in the page; compact.js answers) ---------- */

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  const send = (msg) => chrome.tabs.sendMessage(tab.id, msg)
    .then((res) => { $('compact').checked = res.on; $('compact').disabled = false; })
    .catch(() => {
      $('compact').disabled = true;
      $('compactHint').hidden = false;
      $('compactHint').textContent = 'Open Google Analytics in this tab to switch it (reload the tab if it was open before the extension was updated).';
    });

  send({ type: 'gac:get' });
  $('compact').addEventListener('change', () => send({ type: 'gac:set', on: $('compact').checked }));
});
