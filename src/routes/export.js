const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth } = require('../auth');

// GET /export/report.xlsx — all URLs with latest snapshot
router.get('/report.xlsx', requireAuth, async (req, res) => {
  try {
    const { rows: urls } = await pool.query(`
      SELECT
        mu.id, mu.url, mu.email, mu.check_interval_minutes, mu.is_active,
        mu.created_at,
        ls.title, ls.description, ls.h1, ls.status_code, ls.noindex,
        ls.redirect_url, ls.canonical, ls.checked_at AS last_checked,
        ls.og_title, ls.og_description, ls.og_image, ls.hreflang,
        COALESCE(ac.alert_count, 0)::int AS recent_alert_count
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT title, description, h1, status_code, noindex, redirect_url,
               canonical, checked_at, og_title, og_description, og_image, hreflang
        FROM snapshots
        WHERE url_id = mu.id
        ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS alert_count
        FROM alerts
        WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
      ) ac ON true
      ORDER BY mu.id
    `);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MetaWatch';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('URLs Report');

    // Header row
    const headers = [
      'ID', 'URL', 'Status Code', 'Title', 'Description', 'H1',
      'noindex', 'Canonical', 'Redirect', 'OG Title', 'OG Description',
      'hreflang', 'Last Checked', 'Alerts (24h)', 'Active', 'Email', 'Interval (min)'
    ];

    const headerRow = sheet.addRow(headers);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FF1A202C' }
    };
    headerRow.height = 20;

    // Freeze header
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];

    // Set column widths
    sheet.getColumn(1).width = 6;
    sheet.getColumn(2).width = 50;
    sheet.getColumn(3).width = 12;
    for (let i = 4; i <= headers.length; i++) sheet.getColumn(i).width = 20;

    const orangeFill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FFFFF3CD' }
    };

    for (const u of urls) {
      const row = sheet.addRow([
        u.id,
        u.url,
        u.status_code || '',
        u.title || '',
        u.description || '',
        u.h1 || '',
        u.noindex ? 'noindex' : 'index',
        u.canonical || '',
        u.redirect_url || '',
        u.og_title || '',
        u.og_description || '',
        u.hreflang || '',
        u.last_checked ? new Date(u.last_checked).toISOString() : '',
        u.recent_alert_count,
        u.is_active ? 'Yes' : 'No',
        u.email || '',
        u.check_interval_minutes
      ]);

      // Orange fill for rows with recent alerts
      if (u.recent_alert_count > 0) {
        row.eachCell(cell => { cell.fill = orangeFill; });
      }

      // Status code color
      const statusCell = row.getCell(3);
      if (u.status_code === 200) {
        statusCell.font = { color: { argb: 'FF276749' } };
      } else if (u.status_code >= 400 || u.status_code === 0) {
        statusCell.font = { color: { argb: 'FF9B2C2C' } };
      }
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="metawatch-report-${formatDate(new Date())}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

// GET /export/url/:id.xlsx — single URL full history
router.get('/url/:id.xlsx', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(400).send('Invalid URL ID');

  try {
    const { rows: [urlRecord] } = await pool.query(
      'SELECT * FROM monitored_urls WHERE id = $1', [urlId]
    );
    if (!urlRecord) return res.status(404).send('URL not found');

    const { rows: snapshots } = await pool.query(
      'SELECT * FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC',
      [urlId]
    );

    const { rows: alerts } = await pool.query(
      'SELECT * FROM alerts WHERE url_id = $1 ORDER BY detected_at DESC',
      [urlId]
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MetaWatch';

    // Snapshots sheet
    const snapSheet = workbook.addWorksheet('Snapshots');
    const snapHeaders = ['ID', 'Checked At', 'Status Code', 'Title', 'Description', 'H1',
      'noindex', 'Canonical', 'Redirect', 'OG Title', 'OG Image', 'hreflang'];
    const snapHdr = snapSheet.addRow(snapHeaders);
    snapHdr.font = { bold: true };
    snapSheet.getColumn(1).width = 8;
    snapSheet.getColumn(2).width = 22;
    for (let i = 3; i <= snapHeaders.length; i++) snapSheet.getColumn(i).width = 20;

    for (const s of snapshots) {
      snapSheet.addRow([
        s.id,
        s.checked_at ? new Date(s.checked_at).toISOString() : '',
        s.status_code || '',
        s.title || '',
        s.description || '',
        s.h1 || '',
        s.noindex ? 'noindex' : 'index',
        s.canonical || '',
        s.redirect_url || '',
        s.og_title || '',
        s.og_image || '',
        s.hreflang || ''
      ]);
    }

    // Alerts sheet
    const alertSheet = workbook.addWorksheet('Change History');
    const alertHeaders = ['ID', 'Detected At', 'Field', 'Old Value', 'New Value'];
    const alertHdr = alertSheet.addRow(alertHeaders);
    alertHdr.font = { bold: true };
    alertSheet.getColumn(1).width = 8;
    alertSheet.getColumn(2).width = 22;
    alertSheet.getColumn(3).width = 18;
    alertSheet.getColumn(4).width = 40;
    alertSheet.getColumn(5).width = 40;

    for (const a of alerts) {
      const row = alertSheet.addRow([
        a.id,
        new Date(a.detected_at).toISOString(),
        a.field_changed,
        a.old_value || '',
        a.new_value || ''
      ]);
      row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F5' } };
      row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FFF4' } };
    }

    const safeName = urlRecord.url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}-${formatDate(new Date())}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

// GET /export/alerts.csv — all alerts as CSV
router.get('/alerts.csv', requireAuth, async (req, res) => {
  try {
    const { rows: alerts } = await pool.query(`
      SELECT
        a.id, a.detected_at, a.field_changed, a.old_value, a.new_value,
        mu.url
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      ORDER BY a.detected_at DESC
    `);

    const lines = [
      ['ID', 'Detected At', 'URL', 'Field', 'Old Value', 'New Value']
        .map(csvCell).join(',')
    ];

    for (const a of alerts) {
      lines.push([
        a.id,
        new Date(a.detected_at).toISOString(),
        a.url,
        a.field_changed,
        a.old_value || '',
        a.new_value || ''
      ].map(csvCell).join(','));
    }

    const csv = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="metawatch-alerts-${formatDate(new Date())}.csv"`);
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8
  } catch (err) {
    console.error(err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

function csvCell(val) {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

module.exports = router;
