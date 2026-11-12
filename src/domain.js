'use strict';
const crypto = require('crypto');

function toEnglishDigits(value) {
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, ch => {
    const fa = '۰۱۲۳۴۵۶۷۸۹';
    const ar = '٠١٢٣٤٥٦٧٨٩';
    const n = fa.indexOf(ch);
    return String(n >= 0 ? n : ar.indexOf(ch));
  });
}

function normalizePhone(value) {
  return toEnglishDigits(value).replace(/[\s()\-]/g, '');
}

function validPhone(value) {
  return /^\+?[0-9]{8,15}$/.test(normalizePhone(value));
}

function normalizeInstagram(value) {
  return String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
}

function validInstagram(value) {
  const normalized = normalizeInstagram(value);
  return normalized.length >= 1 && normalized.length <= 30 && /^[a-z0-9._]+$/.test(normalized);
}

function validFullName(value) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  return normalized.length >= 3 && normalized.length <= 150;
}

function makeRaffleCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  while (out.length < 8) {
    for (const byte of crypto.randomBytes(16)) {
      const ceiling = Math.floor(256 / chars.length) * chars.length;
      if (byte >= ceiling) continue;
      out += chars[byte % chars.length];
      if (out.length === 8) break;
    }
  }
  return `LOT-${out}`;
}

module.exports = { toEnglishDigits, normalizePhone, validPhone, normalizeInstagram, validInstagram, validFullName, makeRaffleCode };
