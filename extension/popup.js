/* MetaWatch Browser Extension — Popup */

const $ = id => document.getElementById(id);

let settings = { url: '', key: '' };

// ─── Init ────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['mwUrl', 'mwKey'], data => {
  settings.url = (data.mwUrl || '').replace(/\/$/, '');
  settings.key = data.mwKey || '';

  if (!settings.url || !settings.key) {
    showSettings(true);
    return;
  }

  $('mw-url').value = settings.url;
  $('mw-key').value = settings.key;
  checkCurrentTab();
});

// ─── Settings panel toggle ────────────────────────────────────────────────────
$('settings-btn').addEventListener('click', () => {
  const panel = $('settings-panel');
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
});

$('save-settings').addEventListener('click', () => {
  const url = $('mw-url').value.trim().replace(/\/$/, '');
  const key = $('mw-key').value.trim();
  if (!url || !key) { alert('Please fill in both fields.'); return; }
  chrome.storage.local.set({ mwUrl: url, mwKey: key }, () => {
    settings.url = url;
    settings.key = key;
    showSettings(false);
    checkCurrentTab();
  });
});

// ─── Check current tab ────────────────────────────────────────────────────────
function checkCurrentTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url) { showError('No active tab.'); return; }

    let domain;
    try {
      domain = new URL(tab.url).hostname;
    } catch {
      showError('Cannot parse tab URL.');
      return;
    }

    // Strip www.
    const cleanDomain = domain.replace(/^www\./, '');
    $('domain-info').textContent = cleanDomain;
    $('loading').style.display = '';
    $('error-msg').style.display = 'none';
    $('status-section').style.display = 'none';
    $('not-monitored').style.display = 'none';

    fetch(`${settings.url}/api/uptime/check-domain?domain=${encodeURIComponent(cleanDomain)}`, {
      headers: { 'X-API-Key': settings.key }
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        $('loading').style.display = 'none';
        if (!data.monitored) {
          showNotMonitored(tab.url, cleanDomain);
        } else {
          showStatus(data, tab.url);
        }
      })
      .catch(err => {
        showError('Could not reach MetaWatch: ' + err.message);
      });
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showSettings(open) {
  $('settings-panel').style.display = open ? '' : 'none';
  $('main-panel').style.display = open ? 'none' : '';
}

function showError(msg) {
  $('loading').style.display = 'none';
  $('error-msg').style.display = '';
  $('error-msg').textContent = msg;
}

function showNotMonitored(tabUrl, domain) {
  $('not-monitored').style.display = '';
  $('status-section').style.display = 'none';
  $('add-btn').style.display = '';
  $('view-btn').style.display = 'none';

  $('add-btn').onclick = () => {
    const addUrl = `${settings.url}/urls/add?url=${encodeURIComponent(tabUrl)}`;
    chrome.tabs.create({ url: addUrl });
    window.close();
  };
}

function showStatus(data, tabUrl) {
  $('status-section').style.display = '';
  $('not-monitored').style.display = 'none';

  const dot  = $('status-dot');
  const text = $('status-text');
  const sub  = $('status-sub');

  // Map status to dot class + label
  const statusMap = {
    up:      { cls: 'up',      label: 'UP',       color: '#48bb78' },
    down:    { cls: 'down',    label: 'DOWN',     color: '#e53e3e' },
    degraded:{ cls: 'degraded',label: 'DEGRADED', color: '#ed8936' },
    pending: { cls: 'unknown', label: 'PENDING',  color: '#a0aec0' }
  };
  const s = statusMap[data.status] || statusMap.pending;
  dot.className = 'status-dot ' + s.cls;
  text.textContent = s.label;
  text.style.color = s.color;

  // Sub-text: last checked
  if (data.last_checked_at) {
    const ago = timeAgo(new Date(data.last_checked_at));
    sub.textContent = 'Last check: ' + ago;
  } else {
    sub.textContent = 'Not yet checked';
  }

  // Metrics
  $('rt-val').textContent = data.response_time_ms != null ? data.response_time_ms + ' ms' : '—';
  $('uptime-val').textContent = data.uptime_30d != null ? data.uptime_30d.toFixed(2) + '%' : '—';

  // Buttons
  $('add-btn').style.display = 'none';
  $('view-btn').style.display = '';

  const detailUrl = `${settings.url}/uptime/${data.monitor_id}`;
  $('view-btn').onclick = () => {
    chrome.tabs.create({ url: detailUrl });
    window.close();
  };
}

// ─── Simple time-ago ──────────────────────────────────────────────────────────
function timeAgo(date) {
  const diffSec = Math.round((Date.now() - date) / 1000);
  if (diffSec < 60)  return diffSec + 's ago';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60)  return diffMin + 'min ago';
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24)   return diffHr + 'h ago';
  return Math.round(diffHr / 24) + 'd ago';
}
