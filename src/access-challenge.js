const CHALLENGE_RULES = [
  { pattern: /checking your browser/i, reason: 'Browser verification challenge detected' },
  { pattern: /just a moment/i, reason: 'Browser verification challenge detected' },
  { pattern: /verify you are human/i, reason: 'Human verification challenge detected' },
  { pattern: /enable javascript and cookies/i, reason: 'JavaScript/cookies challenge detected' },
  { pattern: /attention required/i, reason: 'Access challenge page detected' },
  { pattern: /cf[-\s_]?challenge|cloudflare/i, reason: 'Cloudflare challenge detected' },
  { pattern: /captcha|recaptcha|hcaptcha/i, reason: 'CAPTCHA challenge detected' },
  { pattern: /ddos-guard/i, reason: 'DDoS-Guard challenge detected' },
  { pattern: /access denied|forbidden/i, reason: 'Access denied challenge detected' },
  { pattern: /ваш браузер не смог пройти\s*проверку/i, reason: 'Browser verification challenge detected' },
  { pattern: /проверка браузера|проверка безопасности/i, reason: 'Browser verification challenge detected' },
  { pattern: /подтвердите,?\s*что вы человек/i, reason: 'Human verification challenge detected' }
];

function detectAccessChallenge({ title, description, h1, bodyText, statusCode }) {
  const haystack = [
    String(title || ''),
    String(description || ''),
    String(h1 || ''),
    String(bodyText || '')
  ]
    .join('\n')
    .slice(0, 4000);

  for (const rule of CHALLENGE_RULES) {
    if (rule.pattern.test(haystack)) {
      return { detected: true, reason: rule.reason };
    }
  }

  const code = parseInt(statusCode || 0, 10);
  if ([401, 403, 429, 503].includes(code) && /\b(access|forbidden|captcha|challenge|blocked)\b/i.test(haystack)) {
    return { detected: true, reason: 'Access challenge detected' };
  }

  return { detected: false, reason: null };
}

module.exports = { detectAccessChallenge };
