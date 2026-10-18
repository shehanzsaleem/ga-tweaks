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
