const pool = require('./db');

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(meta));
  } catch {
    return {};
  }
}

async function logAudit({ userId, action, entityType, entityId, ip, userAgent, meta }) {
  if (!userId || !action) return;
  try {
    await pool.query(
      `INSERT INTO audit_log
         (user_id, action, entity_type, entity_id, ip, user_agent, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        userId,
        String(action),
        entityType ? String(entityType) : null,
        entityId ? String(entityId) : null,
        ip ? String(ip).substring(0, 128) : null,
        userAgent ? String(userAgent).substring(0, 255) : null,
        JSON.stringify(sanitizeMeta(meta))
      ]
    );
  } catch (err) {
    console.warn('[Audit] Failed to write audit log:', err.message);
  }
}

function auditFromRequest(req, payload) {
  return logAudit({
    userId: req.user?.id || null,
    ip: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.headers['user-agent'] || null,
    ...payload
  });
}

module.exports = { logAudit, auditFromRequest };
