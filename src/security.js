'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createSameOriginGuard() {
  return function sameOriginGuard(req, res, next) {
    const method = String(req.method || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method) || String(req.path || '').startsWith('/telegram/')) return next();

    const fetchSite = String(req.get ? req.get('sec-fetch-site') || '' : req.headers?.['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite === 'cross-site') return res.status(403).send('درخواست بین‌سایتی مجاز نیست.');

    const origin = String(req.get ? req.get('origin') || '' : req.headers?.origin || '');
    const host = String(req.get ? req.get('host') || '' : req.headers?.host || '').toLowerCase();
    if (!origin || !host || origin === 'null') return res.status(403).send('مبدأ درخواست قابل تأیید نیست.');

    try {
      const parsed = new URL(origin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== host) {
        return res.status(403).send('مبدأ درخواست با میزبان پنل یکسان نیست.');
      }
    } catch {
      return res.status(403).send('مبدأ درخواست نامعتبر است.');
    }
    return next();
  };
}

module.exports = { createSameOriginGuard };
