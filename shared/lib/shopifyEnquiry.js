/**
 * shared/lib/shopifyEnquiry.js
 *
 * Pure helpers for website enquiries arriving through a Shopify App Proxy:
 * signature verification, field validation, phone normalisation and the
 * description the sales team reads. No I/O, no framework imports.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { describeSource } from './webEnquiry.js';

const MAX_AGE_SEC = 300;

export const PROJECT_TYPES = ['Residential', 'Commercial', 'Hospitality'];
export const PRODUCT_INTERESTS = ['Dining', 'Lounge', 'Bar Stool', 'Desk', 'Other'];

/**
 * Shopify App Proxy signature: HMAC-SHA256 (hex) of the query parameters,
 * excluding `signature`, each as key=value (repeated keys comma-joined),
 * sorted by key and concatenated WITHOUT a separator, keyed with the app secret.
 * The request body is not signed.
 *
 * @param {URLSearchParams} params
 * @param {string} secret
 * @param {{ now?: number, maxAgeSec?: number }} [opts]  now in epoch seconds
 */
export function verifyProxySignature(params, secret, { now = Math.floor(Date.now() / 1000), maxAgeSec = MAX_AGE_SEC } = {}) {
  if (!secret) return false;
  const given = params.get('signature');
  if (!given) return false;

  const grouped = {};
  for (const [k, v] of params.entries()) {
    if (k === 'signature') continue;
    (grouped[k] ||= []).push(v);
  }
  const message = Object.keys(grouped).sort().map(k => `${k}=${grouped[k].join(',')}`).join('');
  const expected = createHmac('sha256', secret).update(message).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(given), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const ts = parseInt(params.get('timestamp'), 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxAgeSec) return false;
  return true;
}

/**
 * Store Kenyan numbers as +254XXXXXXXXX; leave other international numbers as +digits.
 * Returns null when it cannot be a phone number.
 */
export function formatPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  if (digits.length === 12 && digits.startsWith('254')) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) return `+254${digits.slice(1)}`;
  if (digits.length === 9) return `+254${digits}`;
  if (String(raw).trim().startsWith('+')) return `+${digits}`;
  return null;
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
export const CONSENT_VERSION = 'tsc-consent-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts keys as `contact[name]` or `name`. */
function flatten(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    const m = /^contact\[(.+)\]$/.exec(k);
    out[m ? m[1] : k] = typeof v === 'string' ? v : String(v ?? '');
  }
  return out;
}

/**
 * @returns {{ ok: true, spam?: boolean, value: object } | { ok: false, errors: string[] }}
 *   `spam: true` means the honeypot was filled: drop silently, report success.
 */
export function parseEnquiryFields(fields) {
  const f = flatten(fields);
  if (clean(f.company_website, 200)) return { ok: true, spam: true, value: null };

  const errors = [];
  const name = clean(f.name, 120);
  const email = clean(f.email, 200).toLowerCase();
  const phone = formatPhone(clean(f.phone, 40));
  const body = clean(f.body, 2000);
  const submissionId = clean(f.submission_id, 64).toLowerCase();

  if (!name) errors.push('Name is required.');
  if (!phone) errors.push('A valid phone or WhatsApp number is required.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Email address is not valid.');
  if (!body) errors.push('Please describe what you need.');
  if (!UUID.test(submissionId)) errors.push('Missing submission id.');
  // Personal data is stored in a second system (the CRM): consent must be explicit.
  if (clean(f.consent, 10).toLowerCase() !== 'yes') errors.push('Please tick the box to agree to be contacted.');

  const projectType = PROJECT_TYPES.includes(f.project_type) ? f.project_type : '';
  const productInterest = PRODUCT_INTERESTS.includes(f.product_interest) ? f.product_interest : '';

  const qty = parseInt(f.quantity, 10);
  const quantity = Number.isFinite(qty) && qty > 0 && qty < 100000 ? qty : null;

  let referenceLink = clean(f.reference_link, 500);
  if (referenceLink && !/^https?:\/\/[^\s]+$/i.test(referenceLink)) referenceLink = '';

  // Where the visitor came from (first-touch, captured by the theme; never trusted for anything but reporting).
  const url = v => { const x = clean(v, 500); return /^https?:\/\/[^\s]+$/i.test(x) ? x : ''; };
  const attribution = {};
  for (const k of UTM_KEYS) { const x = clean(f[k], 100); if (x) attribution[k] = x; }
  const landing = url(f.landing_page); if (landing) attribution.landing_page = landing;
  const referrer = url(f.referrer); if (referrer) attribution.referrer = referrer;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      submissionId, name, email: email || null, phone, body,
      projectType, productInterest, quantity,
      budget: clean(f.budget, 100), referenceLink,
      company: clean(f.company, 120), location: clean(f.location, 120),
      attribution,
    },
  };
}

// describeSource lives in webEnquiry.js (no node-only imports, so the browser can use it too).
export { describeSource };

/** What the salesperson sees as the enquiry description. */
export function buildDescription(v) {
  const lines = [v.body];
  const facts = [
    v.projectType && `Project type: ${v.projectType}`,
    v.company && `Company / venue: ${v.company}`,
    v.location && `Location: ${v.location}`,
    v.productInterest && `Product: ${v.productInterest}`,
    v.quantity && `Quantity: ${v.quantity}`,
    v.budget && `Budget: ${v.budget}`,
    v.referenceLink && `Reference: ${v.referenceLink}`,
    describeSource(v.attribution) && `Came from: ${describeSource(v.attribution)}`,
    v.attribution?.landing_page && `Landing page: ${v.attribution.landing_page}`,
  ].filter(Boolean);
  if (facts.length) lines.push('', ...facts);
  return lines.join('\n');
}
