/* MetaWatch v2 frontend JS */

// ─── Relative time display ───
function timeAgo(dateStr, mode) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = mode === 'future' ? date - now : now - date;
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHr  = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHr / 24);

  if (mode === 'future') {
    if (diffSec < 0)  return 'overdue';
    if (diffSec < 60) return `in ${diffSec}s`;
    if (diffMin < 60) return `in ${diffMin}min`;
    if (diffHr  < 24) return `in ${diffHr}h`;
    return `in ${diffDay}d`;
  }

  if (diffSec < 5)  return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}min ago`;
  if (diffHr  < 24) return `${diffHr}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function updateTimes() {
  document.querySelectorAll('.time-ago[data-ts]').forEach(el => {
    const ts   = el.getAttribute('data-ts');
    const mode = el.getAttribute('data-mode') || 'past';
    if (ts) el.textContent = timeAgo(ts, mode);
  });
}

updateTimes();
setInterval(updateTimes, 30000);

// ─── Confirm dialogs ───
document.querySelectorAll('form[data-confirm]').forEach(form => {
  form.addEventListener('submit', function (e) {
    const msg = this.getAttribute('data-confirm');
    if (!confirm(msg)) e.preventDefault();
  });
});

// ─── URL search / filter ───
const urlSearch = document.getElementById('url-search');
if (urlSearch) {
  urlSearch.addEventListener('input', function () {
    const q = this.value.trim().toLowerCase();
    document.querySelectorAll('.url-row').forEach(row => {
      const text = row.querySelector('.url-text')?.textContent?.toLowerCase() || '';
      row.style.display = !q || text.includes(q) ? '' : 'none';
    });
  });
}

// ─── Check-now loading state ───
document.querySelectorAll('form').forEach(form => {
  if (form.action && form.action.includes('check-now')) {
    form.addEventListener('submit', function () {
      const btn = this.querySelector('button[type=submit]');
      if (btn) { btn.textContent = '⏳ Checking...'; btn.disabled = true; }
    });
  }
});

// ─── Scan All + SSE progress ───
const scanAllBtn = document.getElementById('scan-all-btn');
const scanModal  = document.getElementById('scan-modal');
const scanBar    = document.getElementById('scan-progress-bar');
const scanText   = document.getElementById('scan-status-text');
const scanLog    = document.getElementById('scan-log');

let scanEs = null;

if (scanAllBtn) {
  scanAllBtn.addEventListener('click', async () => {
    scanAllBtn.disabled = true;
    scanAllBtn.textContent = '⏳ Starting...';

    try {
      const resp = await fetch('/urls/scan-all', { method: 'POST' });
      const data = await resp.json();

      if (!data.ok) {
        alert(data.error || 'Could not start scan.');
        scanAllBtn.disabled = false;
        scanAllBtn.textContent = '⟳ Scan All';
        return;
      }

      openScanModal(data.total);
    } catch (err) {
      alert('Scan failed: ' + err.message);
      scanAllBtn.disabled = false;
      scanAllBtn.textContent = '⟳ Scan All';
    }
  });
}

function openScanModal(total) {
  if (!scanModal) return;
  scanModal.style.display = 'flex';
  scanBar.style.width = '0%';
  scanLog.innerHTML = '';
  scanText.textContent = `Scanning 0 / ${total} URLs…`;

  if (scanEs) scanEs.close();
  scanEs = new EventSource('/api/scan-stream');

  scanEs.onmessage = function (e) {
    const data = JSON.parse(e.data);

    if (data.type === 'progress') {
      const pct = total > 0 ? Math.round((data.done / total) * 100) : 0;
      scanBar.style.width = pct + '%';
      scanText.textContent = `Scanning ${data.done} / ${data.total} URLs…`;

      const entry = document.createElement('div');
      entry.className = 'scan-log-entry scan-log-entry--' + (data.status === 'ok' ? 'ok' : 'error');
      entry.textContent = (data.status === 'ok' ? '✓' : '✗') + ' ' + data.url;
      scanLog.prepend(entry);
    }

    if (data.type === 'done') {
      scanBar.style.width = '100%';
      scanText.textContent = `Done! Checked ${data.done} URLs.`;
      if (scanEs) scanEs.close();
      setTimeout(() => {
        if (scanModal) scanModal.style.display = 'none';
        if (scanAllBtn) { scanAllBtn.disabled = false; scanAllBtn.textContent = '⟳ Scan All'; }
        window.location.reload();
      }, 2000);
    }
  };

  scanEs.onerror = function () {
    scanText.textContent = 'Connection error. Check console.';
    if (scanEs) scanEs.close();
    if (scanAllBtn) { scanAllBtn.disabled = false; scanAllBtn.textContent = '⟳ Scan All'; }
  };
}

// Close scan modal on background click
if (scanModal) {
  scanModal.addEventListener('click', (e) => {
    if (e.target === scanModal) {
      scanModal.style.display = 'none';
      if (scanEs) scanEs.close();
      if (scanAllBtn) { scanAllBtn.disabled = false; scanAllBtn.textContent = '⟳ Scan All'; }
    }
  });
}

// ─── Chart.js — Dashboard charts ───
function initCharts() {
  const chartStatus   = document.getElementById('chart-status');
  const chartIndex    = document.getElementById('chart-index');
  const chartChanges  = document.getElementById('chart-changes');
  const chartTrend    = document.getElementById('chart-trend');

  if (!chartStatus && !chartIndex && !chartChanges && !chartTrend) return;
  if (typeof Chart === 'undefined') return;

  fetch('/api/stats')
    .then(r => r.json())
    .then(stats => {

      // Shared donut options
      const donutOpts = {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { font: { size: 12 }, boxWidth: 14, padding: 10 }
          }
        }
      };

      // Status codes donut
      if (chartStatus && stats.statusCodes) {
        const codes = Object.keys(stats.statusCodes);
        const vals  = Object.values(stats.statusCodes);
        const colors = codes.map(c => {
          if (c === '200') return '#48bb78';
          if (c >= '300' && c < '400') return '#ed8936';
          if (c >= '400') return '#e53e3e';
          return '#a0aec0';
        });
        new Chart(chartStatus, {
          type: 'doughnut',
          data: { labels: codes, datasets: [{ data: vals, backgroundColor: colors, borderWidth: 2 }] },
          options: donutOpts
        });
      }

      // Indexability donut
      if (chartIndex && stats.indexability) {
        const { indexed, noindex } = stats.indexability;
        new Chart(chartIndex, {
          type: 'doughnut',
          data: {
            labels: ['Indexed', 'noindex'],
            datasets: [{ data: [indexed, noindex], backgroundColor: ['#48bb78', '#e53e3e'], borderWidth: 2 }]
          },
          options: donutOpts
        });
      }

      // Change status donut
      if (chartChanges && stats.changeStatus) {
        const { changed, unchanged } = stats.changeStatus;
        new Chart(chartChanges, {
          type: 'doughnut',
          data: {
            labels: ['Changed (24h)', 'Unchanged'],
            datasets: [{ data: [changed, unchanged], backgroundColor: ['#ed8936', '#48bb78'], borderWidth: 2 }]
          },
          options: donutOpts
        });
      }

      // Alerts trend line
      if (chartTrend && stats.alertsPerDay && stats.alertsPerDay.length > 0) {
        const labels = stats.alertsPerDay.map(d => d.date);
        const values = stats.alertsPerDay.map(d => d.count);
        new Chart(chartTrend, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'Alerts per day',
              data: values,
              borderColor: '#4299e1',
              backgroundColor: 'rgba(66,153,225,.1)',
              tension: 0.3,
              fill: true,
              pointRadius: 3
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { ticks: { font: { size: 10 } } },
              y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 10 } } }
            },
            plugins: { legend: { display: false } }
          }
        });
      }
    })
    .catch(err => console.warn('Chart data load failed:', err.message));
}

// ─── Response time chart (url-detail page) ───
function initResponseTimeChart() {
  const canvas = document.getElementById('chart-response-time');
  if (!canvas || typeof Chart === 'undefined') return;

  const urlId = canvas.getAttribute('data-url-id');
  fetch('/api/url/' + urlId + '/response-times')
    .then(r => r.json())
    .then(data => {
      if (!data.length) {
        canvas.parentElement.style.display = 'none';
        return;
      }
      const labels = data.map(d => {
        const dt = new Date(d.checked_at);
        return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      });
      const values = data.map(d => d.response_time_ms);
      new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'ms',
            data: values,
            borderColor: '#4299e1',
            backgroundColor: 'rgba(66,153,225,.08)',
            tension: 0.3,
            fill: true,
            pointRadius: 2,
            pointHoverRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { ticks: { font: { size: 10 }, maxTicksLimit: 12 } },
            y: { beginAtZero: true, ticks: { font: { size: 10 } } }
          },
          plugins: { legend: { display: false } }
        }
      });
    })
    .catch(() => {});
}

// ─── Test Notification button ─────────────────────────────────────────────
const testNotifyBtn = document.getElementById('test-notify-btn');
if (testNotifyBtn) {
  testNotifyBtn.addEventListener('click', async function () {
    const urlId = this.getAttribute('data-url-id');
    const orig = this.textContent;
    this.textContent = 'Sending…';
    this.disabled = true;
    try {
      const r = await fetch('/urls/' + urlId + '/test-notify', { method: 'POST' });
      const data = await r.json();
      this.textContent = data.ok ? '✓ Sent!' : '⚠ ' + data.message;
      setTimeout(() => {
        this.textContent = orig;
        this.disabled = false;
      }, 4000);
    } catch (e) {
      this.textContent = '⚠ Error';
      setTimeout(() => { this.textContent = orig; this.disabled = false; }, 3000);
    }
  });
}

// Wait for Chart.js CDN to load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initCharts(); initResponseTimeChart(); });
} else {
  window.addEventListener('load', () => { initCharts(); initResponseTimeChart(); });
}
