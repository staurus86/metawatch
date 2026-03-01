const nodemailer = require('nodemailer');

function isEmailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    tls: { rejectUnauthorized: false }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatValue(val) {
  if (val === null || val === undefined || val === 'null' || val === '') {
    return '<em style="color:#a0aec0">(empty)</em>';
  }
  return `<pre style="white-space:pre-wrap;word-break:break-all;margin:0;font-size:13px">${escapeHtml(String(val))}</pre>`;
}

async function sendAlert({ to, url, field, oldValue, newValue, timestamp }) {
  if (!isEmailConfigured()) {
    console.log(`[Email skipped — no SMTP config] ${field} changed on ${url}`);
    return false;
  }

  const subject = `[MetaWatch] Change detected: ${field} on ${url}`;
  const ts = new Date(timestamp).toUTCString();
  const dashboardUrl = process.env.BASE_URL || '#';

  const html = `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#2d3748;background:#f7fafc">
  <div style="background:#1a202c;color:white;padding:16px 24px;border-radius:8px 8px 0 0;display:flex;align-items:center">
    <span style="font-size:22px;margin-right:10px">👁</span>
    <h2 style="margin:0;font-size:18px;font-weight:600">MetaWatch Alert</h2>
  </div>
  <div style="background:white;border:1px solid #e2e8f0;border-top:none;padding:24px;border-radius:0 0 8px 8px">
    <p style="margin-top:0;color:#4a5568">A change was detected on your monitored page:</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px">
      <tr style="border-bottom:1px solid #e2e8f0">
        <td style="padding:10px 12px;background:#f7fafc;font-weight:600;width:130px;color:#2d3748">URL</td>
        <td style="padding:10px 12px"><a href="${escapeHtml(url)}" style="color:#4299e1;word-break:break-all">${escapeHtml(url)}</a></td>
      </tr>
      <tr style="border-bottom:1px solid #e2e8f0">
        <td style="padding:10px 12px;background:#f7fafc;font-weight:600;color:#2d3748">Field</td>
        <td style="padding:10px 12px"><strong style="color:#e53e3e">${escapeHtml(field)}</strong></td>
      </tr>
      <tr>
        <td style="padding:10px 12px;background:#f7fafc;font-weight:600;color:#2d3748">Detected At</td>
        <td style="padding:10px 12px;color:#718096">${ts}</td>
      </tr>
    </table>
    <h3 style="color:#e53e3e;margin-bottom:8px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em">Previous Value</h3>
    <div style="background:#fff5f5;border-left:4px solid #e53e3e;padding:12px;margin-bottom:16px;border-radius:4px">
      ${formatValue(oldValue)}
    </div>
    <h3 style="color:#38a169;margin-bottom:8px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em">New Value</h3>
    <div style="background:#f0fff4;border-left:4px solid #38a169;padding:12px;border-radius:4px">
      ${formatValue(newValue)}
    </div>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
    <p style="color:#718096;font-size:12px;margin:0">
      <a href="${escapeHtml(dashboardUrl)}" style="color:#4299e1">Open MetaWatch Dashboard</a>
      &nbsp;·&nbsp; MetaWatch — Website Metadata Monitor
    </p>
  </div>
</body></html>`;

  try {
    await createTransporter().sendMail({
      from: process.env.SMTP_FROM || 'MetaWatch <alerts@metawatch.app>',
      to,
      subject,
      html
    });
    console.log(`[Email sent] ${field} changed on ${url} → ${to}`);
    return true;
  } catch (err) {
    console.error(`[Email failed] ${err.message}`);
    return false;
  }
}

async function sendDigest({ to, frequency, periodLabel, alerts, incidents, sslExpirations, dateRange }) {
  if (!isEmailConfigured()) return false;

  const dashboardUrl = process.env.BASE_URL || '#';
  const isEmpty = (!alerts || alerts.length === 0) && (!incidents || incidents.length === 0) && (!sslExpirations || sslExpirations.length === 0);
  if (isEmpty) return false;

  const totalChanges = (alerts || []).length;
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const subject = frequency === 'weekly'
    ? `MetaWatch Weekly Report — ${dateRange || today}`
    : `MetaWatch Daily — ${totalChanges} change${totalChanges !== 1 ? 's' : ''} [${today}]`;

  const sevColor = { critical: '#e53e3e', warning: '#e53e3e', info: '#718096' };
  const sevLabel = { critical: '🔴 Critical', warning: '🟡 Warning', info: '🔵 Info' };

  // Section 1: Meta changes
  let metaHtml = '';
  if (alerts && alerts.length > 0) {
    const byUrl = {};
    for (const a of alerts) {
      if (!byUrl[a.url]) byUrl[a.url] = { urlId: a.url_id, items: [] };
      byUrl[a.url].items.push(a);
    }
    let rows = '';
    for (const [url, { urlId, items }] of Object.entries(byUrl)) {
      for (const a of items) {
        const sev = a.severity || 'info';
        rows += `<tr style="border-bottom:1px solid #f0f4f8">
          <td style="padding:8px 10px;font-size:12px;max-width:180px;word-break:break-all"><a href="${escapeHtml(dashboardUrl)}/urls/${urlId}" style="color:#4299e1;text-decoration:none">${escapeHtml(url.substring(0, 50))}${url.length > 50 ? '…' : ''}</a></td>
          <td style="padding:8px 10px;font-size:12px;color:#4a5568">${escapeHtml(a.field_changed)}</td>
          <td style="padding:8px 10px;font-size:11px;color:#718096;max-width:120px;word-break:break-all">${escapeHtml(String(a.old_value || '').substring(0, 60))}</td>
          <td style="padding:8px 10px;font-size:11px;color:#2d3748;max-width:120px;word-break:break-all">${escapeHtml(String(a.new_value || '').substring(0, 60))}</td>
          <td style="padding:8px 10px;font-size:11px;color:${sevColor[sev] || '#718096'};font-weight:600">${sevLabel[sev] || sev}</td>
        </tr>`;
      }
    }
    metaHtml = `
      <h3 style="font-size:15px;margin:20px 0 10px;color:#2d3748;border-bottom:2px solid #e2e8f0;padding-bottom:8px">📋 Meta Monitoring Changes (${alerts.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="background:#f7fafc;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#718096">
          <th style="padding:6px 10px;text-align:left">URL</th><th style="padding:6px 10px;text-align:left">Field</th>
          <th style="padding:6px 10px;text-align:left">Before</th><th style="padding:6px 10px;text-align:left">After</th>
          <th style="padding:6px 10px;text-align:left">Severity</th>
        </tr>${rows}
      </table>`;
  }

  // Section 2: Uptime incidents
  let uptimeHtml = '';
  if (incidents && incidents.length > 0) {
    const rows = incidents.map(inc => `
      <tr style="border-bottom:1px solid #f0f4f8">
        <td style="padding:8px 10px;font-size:13px">${escapeHtml(inc.monitor_name || inc.monitor_url || '')}</td>
        <td style="padding:8px 10px;font-size:12px;color:#718096">${new Date(inc.started_at).toUTCString().replace(' GMT','')}</td>
        <td style="padding:8px 10px;font-size:12px">${inc.resolved_at ? `<span style="color:#38a169">Resolved (${Math.round(inc.duration_seconds / 60)}m)</span>` : '<span style="color:#e53e3e">Ongoing</span>'}</td>
        <td style="padding:8px 10px;font-size:11px;color:#718096">${escapeHtml(inc.cause || '—')}</td>
      </tr>`).join('');
    uptimeHtml = `
      <h3 style="font-size:15px;margin:20px 0 10px;color:#2d3748;border-bottom:2px solid #e2e8f0;padding-bottom:8px">🔔 Uptime Incidents (${incidents.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="background:#f7fafc;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#718096">
          <th style="padding:6px 10px;text-align:left">Monitor</th><th style="padding:6px 10px;text-align:left">Started</th>
          <th style="padding:6px 10px;text-align:left">Status</th><th style="padding:6px 10px;text-align:left">Cause</th>
        </tr>${rows}
      </table>`;
  }

  // Section 3: SSL expirations
  let sslHtml = '';
  if (sslExpirations && sslExpirations.length > 0) {
    const rows = sslExpirations.map(s => `
      <tr style="border-bottom:1px solid #f0f4f8">
        <td style="padding:8px 10px;font-size:12px"><a href="${escapeHtml(dashboardUrl)}/urls/${s.url_id}" style="color:#4299e1;text-decoration:none">${escapeHtml(s.url.substring(0, 60))}</a></td>
        <td style="padding:8px 10px;font-size:12px;color:#718096">${new Date(s.ssl_expires_at).toLocaleDateString()}</td>
        <td style="padding:8px 10px;font-size:12px;color:${s.days_left <= 7 ? '#e53e3e' : '#ed8936'};font-weight:600">${s.days_left} days</td>
      </tr>`).join('');
    sslHtml = `
      <h3 style="font-size:15px;margin:20px 0 10px;color:#2d3748;border-bottom:2px solid #e2e8f0;padding-bottom:8px">🔒 Upcoming SSL Expirations</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="background:#f7fafc;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#718096">
          <th style="padding:6px 10px;text-align:left">URL</th><th style="padding:6px 10px;text-align:left">Expires</th><th style="padding:6px 10px;text-align:left">Days Left</th>
        </tr>${rows}
      </table>`;
  }

  const html = `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;color:#2d3748;background:#f7fafc">
  <div style="background:#1a202c;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;font-size:18px;font-weight:600">👁 MetaWatch — ${frequency === 'weekly' ? 'Weekly' : 'Daily'} Report</h2>
    <p style="margin:4px 0 0;font-size:13px;color:#a0aec0">${periodLabel || dateRange || today}</p>
  </div>
  <div style="background:white;border:1px solid #e2e8f0;border-top:none;padding:20px 24px 24px;border-radius:0 0 8px 8px">
    ${metaHtml}${uptimeHtml}${sslHtml}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
    <p style="color:#718096;font-size:12px;margin:0">
      <a href="${escapeHtml(dashboardUrl)}" style="color:#4299e1">Open MetaWatch Dashboard</a>
      &nbsp;·&nbsp; <a href="${escapeHtml(dashboardUrl)}/profile" style="color:#718096">Manage digest settings</a>
    </p>
  </div>
</body></html>`;

  try {
    await createTransporter().sendMail({
      from: process.env.SMTP_FROM || 'MetaWatch <alerts@metawatch.app>',
      to,
      subject,
      html
    });
    console.log(`[Digest sent] ${frequency} → ${to}`);
    return true;
  } catch (err) {
    console.error(`[Digest failed] ${err.message}`);
    return false;
  }
}

module.exports = { sendAlert, sendDigest, isEmailConfigured };
