const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { auditFromRequest } = require('../audit');
const { getUserUsage, isLimitReached, limitLabel } = require('../plans');

function normalizeProjectName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

async function listProjects(userId) {
  const { rows } = await pool.query(`
    WITH latest_snapshot AS (
      SELECT DISTINCT ON (url_id) url_id, status_code
      FROM snapshots
      ORDER BY url_id, checked_at DESC
    ),
    recent_alerts AS (
      SELECT url_id, COUNT(*)::int AS alert_count
      FROM alerts
      WHERE detected_at > NOW() - INTERVAL '24 hours'
      GROUP BY url_id
    )
    SELECT
      p.id,
      p.name,
      p.created_at,
      COUNT(mu.id)::int AS url_count,
      COUNT(*) FILTER (
        WHERE mu.id IS NOT NULL
          AND ls.status_code IS NOT NULL
          AND (ls.status_code = 0 OR ls.status_code >= 400)
      )::int AS error_count,
      COUNT(*) FILTER (
        WHERE mu.id IS NOT NULL
          AND ls.status_code BETWEEN 1 AND 399
          AND COALESCE(ra.alert_count, 0) > 0
      )::int AS changed_count,
      COUNT(*) FILTER (
        WHERE mu.id IS NOT NULL
          AND ls.status_code BETWEEN 1 AND 399
          AND COALESCE(ra.alert_count, 0) = 0
      )::int AS ok_count,
      COUNT(*) FILTER (
        WHERE mu.id IS NOT NULL
          AND ls.status_code IS NULL
      )::int AS pending_count
    FROM projects p
    LEFT JOIN monitored_urls mu
      ON mu.project_id = p.id AND mu.user_id = $1
    LEFT JOIN latest_snapshot ls
      ON ls.url_id = mu.id
    LEFT JOIN recent_alerts ra
      ON ra.url_id = mu.id
    WHERE p.user_id = $1
    GROUP BY p.id
    ORDER BY p.name ASC
  `, [userId]);

  const { rows: [unassigned] } = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM monitored_urls WHERE user_id = $1 AND project_id IS NULL',
    [userId]
  );

  return {
    projects: rows,
    unassignedCount: unassigned?.cnt || 0
  };
}

async function renderProjectsPage(req, res, { status = 200, message = null, error = null, upgradePrompt = null } = {}) {
  const { projects, unassignedCount } = await listProjects(req.user.id);
  return res.status(status).render('projects', {
    title: 'Projects',
    message,
    error,
    projects,
    unassignedCount,
    upgradePrompt
  });
}

// GET /projects
router.get('/', requireAuth, async (req, res) => {
  try {
    await renderProjectsPage(req, res, { message: req.query.msg || null });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /projects/add
router.post('/add', requireAuth, async (req, res) => {
  const name = normalizeProjectName(req.body.name);
  if (!name) return res.redirect('/projects?msg=Project+name+is+required');
  if (name.length > 255) return res.redirect('/projects?msg=Project+name+is+too+long');

  try {
    const usage = await getUserUsage(req.user.id);
    const currentPlan = req.userPlan || { name: 'Free', max_projects: 1 };
    if (isLimitReached(usage.projects, currentPlan.max_projects)) {
      return await renderProjectsPage(req, res, {
        status: 402,
        error: 'Project limit reached for your current plan.',
        upgradePrompt: {
          title: 'Upgrade your plan',
          message: `${currentPlan.name} plan allows up to ${limitLabel(currentPlan.max_projects)} project(s). You currently have ${usage.projects}.`
        }
      });
    }

    const { rows: [existing] } = await pool.query(
      'SELECT id FROM projects WHERE user_id = $1 AND lower(name) = lower($2)',
      [req.user.id, name]
    );
    if (existing) return res.redirect('/projects?msg=Project+with+this+name+already+exists');

    const { rows: [project] } = await pool.query(
      'INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id, name',
      [req.user.id, name]
    );
    await auditFromRequest(req, {
      action: 'project.create',
      entityType: 'project',
      entityId: project.id,
      meta: { name: project.name }
    });
    res.redirect('/projects?msg=Project+created');
  } catch (err) {
    console.error(err);
    res.redirect('/projects?msg=Error:+failed+to+create+project');
  }
});

// POST /projects/:id/rename
router.post('/:id/rename', requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const name = normalizeProjectName(req.body.name);
  if (!Number.isFinite(projectId) || projectId <= 0) return res.redirect('/projects?msg=Invalid+project');
  if (!name) return res.redirect('/projects?msg=Project+name+is+required');
  if (name.length > 255) return res.redirect('/projects?msg=Project+name+is+too+long');

  try {
    const { rows: [existing] } = await pool.query(
      'SELECT id FROM projects WHERE user_id = $1 AND lower(name) = lower($2) AND id <> $3',
      [req.user.id, name, projectId]
    );
    if (existing) return res.redirect('/projects?msg=Project+with+this+name+already+exists');

    const { rows: [updated] } = await pool.query(
      'UPDATE projects SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, name',
      [name, projectId, req.user.id]
    );
    if (!updated) return res.redirect('/projects?msg=Project+not+found');

    await auditFromRequest(req, {
      action: 'project.rename',
      entityType: 'project',
      entityId: updated.id,
      meta: { name: updated.name }
    });
    res.redirect('/projects?msg=Project+renamed');
  } catch (err) {
    console.error(err);
    res.redirect('/projects?msg=Error:+failed+to+rename+project');
  }
});

// POST /projects/:id/delete
router.post('/:id/delete', requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) return res.redirect('/projects?msg=Invalid+project');

  try {
    const { rows: [deleted] } = await pool.query(
      'DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING id, name',
      [projectId, req.user.id]
    );
    if (!deleted) return res.redirect('/projects?msg=Project+not+found');

    await auditFromRequest(req, {
      action: 'project.delete',
      entityType: 'project',
      entityId: deleted.id,
      meta: { name: deleted.name }
    });
    res.redirect('/projects?msg=Project+deleted');
  } catch (err) {
    console.error(err);
    res.redirect('/projects?msg=Error:+failed+to+delete+project');
  }
});

module.exports = router;
