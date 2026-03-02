const test = require('node:test');
const assert = require('node:assert/strict');

const { getReportPlanCaps, enforceReportAccess } = require('../src/report-access');

function createMockRes() {
  return {
    statusCode: 200,
    sent: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.sent = payload;
      return this;
    }
  };
}

test('getReportPlanCaps returns expected max range per plan', () => {
  assert.equal(getReportPlanCaps('free').maxRangeDays, 30);
  assert.equal(getReportPlanCaps('starter').maxRangeDays, 90);
  assert.equal(getReportPlanCaps('pro').maxRangeDays, 365);
  assert.equal(getReportPlanCaps('agency').maxRangeDays, null);
});

test('enforceReportAccess blocks unsupported feature on free plan', () => {
  const req = {
    user: { role: 'viewer' },
    userPlan: { name: 'Free' }
  };
  const res = createMockRes();
  const result = enforceReportAccess({
    req,
    res,
    featureKey: 'projectPdf'
  });

  assert.equal(result.allowed, false);
  assert.equal(res.statusCode, 402);
  assert.match(String(res.sent), /not available/i);
});

test('enforceReportAccess blocks date range overflow', () => {
  const req = {
    user: { role: 'viewer' },
    userPlan: { name: 'Starter' }
  };
  const res = createMockRes();
  const result = enforceReportAccess({
    req,
    res,
    featureKey: 'globalPdf',
    fromDate: new Date('2025-01-01T00:00:00Z'),
    toDate: new Date('2025-06-01T00:00:00Z')
  });

  assert.equal(result.allowed, false);
  assert.equal(res.statusCode, 402);
  assert.match(String(res.sent), /range/i);
});

test('enforceReportAccess bypasses caps for admin', () => {
  const req = {
    user: { role: 'admin' },
    userPlan: { name: 'Free' }
  };
  const res = createMockRes();
  const result = enforceReportAccess({
    req,
    res,
    featureKey: 'projectPdf'
  });

  assert.equal(result.allowed, true);
  assert.equal(res.sent, null);
  assert.equal(result.caps.maxRangeDays, null);
});

