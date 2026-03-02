const DAY_MS = 24 * 60 * 60 * 1000;

const REPORT_PLAN_CAPS = {
  free: {
    maxRangeDays: 30,
    globalPdf: true,
    uptimeGlobalPdf: true,
    globalXlsx: false,
    urlPdf: true,
    urlXlsx: false,
    projectPdf: false,
    projectXlsx: false,
    uptimeGlobalXlsx: false,
    uptimeSitePdf: true,
    uptimeSiteXlsx: false,
    alertsCsv: true,
    scheduledPdfDigest: false
  },
  starter: {
    maxRangeDays: 90,
    globalPdf: true,
    uptimeGlobalPdf: true,
    globalXlsx: true,
    urlPdf: true,
    urlXlsx: true,
    projectPdf: true,
    projectXlsx: true,
    uptimeGlobalXlsx: true,
    uptimeSitePdf: true,
    uptimeSiteXlsx: true,
    alertsCsv: true,
    scheduledPdfDigest: true
  },
  pro: {
    maxRangeDays: 365,
    globalPdf: true,
    uptimeGlobalPdf: true,
    globalXlsx: true,
    urlPdf: true,
    urlXlsx: true,
    projectPdf: true,
    projectXlsx: true,
    uptimeGlobalXlsx: true,
    uptimeSitePdf: true,
    uptimeSiteXlsx: true,
    alertsCsv: true,
    scheduledPdfDigest: true
  },
  agency: {
    maxRangeDays: null,
    globalPdf: true,
    uptimeGlobalPdf: true,
    globalXlsx: true,
    urlPdf: true,
    urlXlsx: true,
    projectPdf: true,
    projectXlsx: true,
    uptimeGlobalXlsx: true,
    uptimeSitePdf: true,
    uptimeSiteXlsx: true,
    alertsCsv: true,
    scheduledPdfDigest: true,
    whiteLabelPdf: true
  }
};

const FEATURE_LABELS = {
  globalPdf: 'dashboard PDF report',
  uptimeGlobalPdf: 'uptime portfolio PDF report',
  globalXlsx: 'dashboard XLSX report',
  urlPdf: 'single URL PDF report',
  urlXlsx: 'single URL XLSX export',
  projectPdf: 'project PDF report',
  projectXlsx: 'project XLSX report',
  uptimeGlobalXlsx: 'uptime XLSX report',
  uptimeSitePdf: 'uptime monitor PDF report',
  uptimeSiteXlsx: 'uptime monitor XLSX report',
  alertsCsv: 'alerts CSV export'
};

function normalizePlanKey(planName) {
  const key = String(planName || 'free').trim().toLowerCase();
  return REPORT_PLAN_CAPS[key] ? key : 'free';
}

function getReportPlanCaps(planName) {
  return REPORT_PLAN_CAPS[normalizePlanKey(planName)];
}

function calcRangeDays(fromDate, toDate) {
  if (!(fromDate instanceof Date) || Number.isNaN(fromDate.getTime())) return null;
  if (!(toDate instanceof Date) || Number.isNaN(toDate.getTime())) return null;
  const diffMs = toDate.getTime() - fromDate.getTime();
  if (diffMs < 0) return -1;
  return Math.ceil(diffMs / DAY_MS);
}

function buildUpgradeMessage({ planName, featureKey, maxRangeDays }) {
  const feature = FEATURE_LABELS[featureKey] || 'this report export';
  const safePlan = String(planName || 'Free');
  const parts = [
    `${feature} is not available on ${safePlan} plan.`,
    'Upgrade your plan in /billing to unlock this export.'
  ];

  if (Number.isFinite(maxRangeDays) && maxRangeDays > 0) {
    parts.unshift(`Selected date range exceeds your plan limit (${maxRangeDays} days).`);
  }

  return parts.join(' ');
}

function enforceReportAccess({ req, res, featureKey, fromDate = null, toDate = null }) {
  if (req.user?.role === 'admin') {
    return { allowed: true, caps: getReportPlanCaps('agency') };
  }

  const planName = String(req.userPlan?.name || 'Free');
  const caps = getReportPlanCaps(planName);

  if (!caps[featureKey]) {
    res.status(402).send(buildUpgradeMessage({ planName, featureKey }));
    return { allowed: false, caps };
  }

  const rangeDays = calcRangeDays(fromDate, toDate);
  if (rangeDays != null && rangeDays >= 0 && Number.isFinite(caps.maxRangeDays) && rangeDays > caps.maxRangeDays) {
    res.status(402).send(buildUpgradeMessage({
      planName,
      featureKey,
      maxRangeDays: caps.maxRangeDays
    }));
    return { allowed: false, caps };
  }

  return { allowed: true, caps };
}

module.exports = {
  getReportPlanCaps,
  enforceReportAccess
};
