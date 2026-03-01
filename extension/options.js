/* MetaWatch Extension — Options page */

const $ = id => document.getElementById(id);
const SETTINGS_KEYS = ['mwUrl', 'mwKey'];

function storageGet(area, keys) {
  return new Promise(resolve => area.get(keys, resolve));
}

function storageSet(area, value) {
  return new Promise(resolve => area.set(value, resolve));
}

async function loadSettings() {
  const syncData = await storageGet(chrome.storage.sync, SETTINGS_KEYS);
  let url = syncData.mwUrl || '';
  let key = syncData.mwKey || '';

  if (!url || !key) {
    const localData = await storageGet(chrome.storage.local, SETTINGS_KEYS);
    if (!url && localData.mwUrl) url = localData.mwUrl;
    if (!key && localData.mwKey) key = localData.mwKey;
    if (url || key) {
      await storageSet(chrome.storage.sync, { mwUrl: url, mwKey: key });
    }
  }

  if (url) $('mw-url').value = url;
  if (key) $('mw-key').value = key;
}

loadSettings();

function showBanner(msg, type) {
  const el = $('banner');
  el.className = 'banner banner-' + type;
  el.textContent = msg;
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function setStatus(msg, cls) {
  $('status-dot').className = 'status-dot ' + cls;
  $('status-text').textContent = msg;
}

$('save-btn').addEventListener('click', () => {
  const url = $('mw-url').value.trim().replace(/\/$/, '');
  const key = $('mw-key').value.trim();
  if (!url || !key) {
    showBanner('Please fill in both fields.', 'err');
    return;
  }
  chrome.storage.sync.set({ mwUrl: url, mwKey: key }, () => {
    showBanner('Settings saved!', 'ok');
    setStatus('Settings saved — click Test to verify', 'idle');
  });
});

$('test-btn').addEventListener('click', async () => {
  const url = $('mw-url').value.trim().replace(/\/$/, '');
  const key = $('mw-key').value.trim();
  if (!url || !key) { showBanner('Enter URL and API key first.', 'err'); return; }

  setStatus('Testing connection…', 'idle');
  $('test-btn').disabled = true;
  try {
    const resp = await fetch(`${url}/api/health`, {
      headers: { 'X-API-Key': key }
    });
    if (resp.ok) {
      setStatus('Connected! MetaWatch is reachable.', 'ok');
    } else {
      setStatus(`Error: HTTP ${resp.status}`, 'err');
    }
  } catch (err) {
    setStatus('Cannot reach MetaWatch. Check the URL.', 'err');
  } finally {
    $('test-btn').disabled = false;
  }
});
