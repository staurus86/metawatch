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

module.exports = { sendAlert, isEmailConfigured };
