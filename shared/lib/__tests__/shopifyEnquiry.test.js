import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyProxySignature, parseEnquiryFields, buildDescription, formatPhone, describeSource } from '../shopifyEnquiry.js';

const SECRET = 'shpss_test_secret';
const NOW = 1_800_000_000;

function signed(extra = {}, { secret = SECRET, ts = NOW } = {}) {
  const base = { shop: 'tsc.myshopify.com', path_prefix: '/apps/tsc', timestamp: String(ts), logged_in_customer_id: '', ...extra };
  const message = Object.keys(base).sort().map(k => `${k}=${base[k]}`).join('');
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  return new URLSearchParams({ ...base, signature });
}

test('valid signature is accepted', () => {
  assert.equal(verifyProxySignature(signed(), SECRET, { now: NOW + 10 }), true);
});

test('wrong secret, tampered param, missing signature are rejected', () => {
  assert.equal(verifyProxySignature(signed({}, { secret: 'other' }), SECRET, { now: NOW }), false);
  const p = signed(); p.set('shop', 'evil.myshopify.com');
  assert.equal(verifyProxySignature(p, SECRET, { now: NOW }), false);
  const q = signed(); q.delete('signature');
  assert.equal(verifyProxySignature(q, SECRET, { now: NOW }), false);
  assert.equal(verifyProxySignature(signed(), '', { now: NOW }), false);
});

test('stale or future timestamps are rejected', () => {
  assert.equal(verifyProxySignature(signed(), SECRET, { now: NOW + 301 }), false);
  assert.equal(verifyProxySignature(signed(), SECRET, { now: NOW - 301 }), false);
  assert.equal(verifyProxySignature(signed(), SECRET, { now: NOW + 299 }), true);
});

test('repeated query keys are comma-joined before signing', () => {
  const base = [['extra', 'b'], ['extra', 'a'], ['shop', 's'], ['timestamp', String(NOW)]];
  const message = 'extra=b,ashop=stimestamp=' + NOW;
  const signature = createHmac('sha256', SECRET).update(message).digest('hex');
  const p = new URLSearchParams(base); p.set('signature', signature);
  assert.equal(verifyProxySignature(p, SECRET, { now: NOW }), true);
});

test('formatPhone: Kenyan shapes become +254XXXXXXXXX', () => {
  assert.equal(formatPhone('0713 196 650'), '+254713196650');
  assert.equal(formatPhone('+254713196650'), '+254713196650');
  assert.equal(formatPhone('254713196650'), '+254713196650');
  assert.equal(formatPhone('713196650'), '+254713196650');
  assert.equal(formatPhone('+44 7700 900123'), '+447700900123');
  assert.equal(formatPhone('12345'), null);
  assert.equal(formatPhone('abc'), null);
});

const ID = '3f2b8c1e-5a47-4d0a-9b6e-1c2d3e4f5a6b';
const good = (extra = {}) => ({
  'contact[name]': ' Jane Wanjiru ', 'contact[phone]': '0713196650', 'contact[email]': 'Jane@Example.com',
  'contact[body]': '40 dining chairs for a restaurant', 'contact[submission_id]': ID,
  'contact[project_type]': 'Hospitality', 'contact[product_interest]': 'Dining', 'contact[quantity]': '40',
  'contact[budget]': 'KES 800k', 'contact[reference_link]': 'https://pin.it/abc', 'contact[consent]': 'yes', ...extra,
});

test('parseEnquiryFields: good submission is normalised', () => {
  const r = parseEnquiryFields(good());
  assert.equal(r.ok, true);
  assert.deepEqual(
    [r.value.name, r.value.phone, r.value.email, r.value.quantity, r.value.projectType],
    ['Jane Wanjiru', '+254713196650', 'jane@example.com', 40, 'Hospitality']);
});

test('parseEnquiryFields: requires name, phone, brief, submission id', () => {
  const r = parseEnquiryFields(good({ 'contact[name]': '', 'contact[phone]': '12', 'contact[body]': '  ', 'contact[submission_id]': 'x' }));
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 4);
});

test('parseEnquiryFields: consent must be explicitly yes', () => {
  assert.equal(parseEnquiryFields(good({ 'contact[consent]': '' })).ok, false);
  assert.equal(parseEnquiryFields(good({ 'contact[consent]': 'no' })).ok, false);
  const { 'contact[consent]': _drop, ...noConsent } = good();
  assert.equal(parseEnquiryFields(noConsent).ok, false);
  assert.match(parseEnquiryFields(good({ 'contact[consent]': '' })).errors.join(' '), /agree to be contacted/);
  assert.equal(parseEnquiryFields(good({ 'contact[consent]': 'YES' })).ok, true);
});

test('parseEnquiryFields: company, location and attribution are captured and sanitised', () => {
  const r = parseEnquiryFields(good({
    'contact[company]': ' Villa Rosa Hotel ', 'contact[location]': 'Westlands, Nairobi',
    'contact[utm_source]': 'google', 'contact[utm_medium]': 'cpc', 'contact[utm_campaign]': 'dining-chairs-oct',
    'contact[landing_page]': 'https://theseatingcompany.co.ke/collections/dining?utm_source=google',
    'contact[referrer]': 'javascript:alert(1)',
  }));
  assert.equal(r.ok, true);
  assert.equal(r.value.company, 'Villa Rosa Hotel');
  assert.equal(r.value.location, 'Westlands, Nairobi');
  assert.deepEqual(r.value.attribution, {
    utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'dining-chairs-oct',
    landing_page: 'https://theseatingcompany.co.ke/collections/dining?utm_source=google',
  });
  assert.equal(parseEnquiryFields(good()).value.attribution.utm_source, undefined);
});

test('describeSource prefers UTM tags, then an external referrer host, else nothing', () => {
  assert.equal(describeSource({ utm_source: 'google', utm_medium: 'cpc' }), 'google / cpc');
  assert.equal(describeSource({ referrer: 'https://www.instagram.com/p/xyz' }), 'instagram.com');
  assert.equal(describeSource({ referrer: 'https://theseatingcompany.co.ke/' }), '');
  assert.equal(describeSource({}), '');
  assert.equal(describeSource(undefined), '');
});

test('parseEnquiryFields: email is optional but must be valid when given', () => {
  assert.equal(parseEnquiryFields(good({ 'contact[email]': '' })).ok, true);
  assert.equal(parseEnquiryFields(good({ 'contact[email]': 'not-an-email' })).ok, false);
});

test('parseEnquiryFields: honeypot short-circuits as spam', () => {
  const r = parseEnquiryFields(good({ 'contact[company_website]': 'http://spam.example' }));
  assert.equal(r.ok, true); assert.equal(r.spam, true); assert.equal(r.value, null);
});

test('parseEnquiryFields: unknown select values, junk quantity and non-http links are dropped', () => {
  const r = parseEnquiryFields(good({
    'contact[project_type]': '<script>', 'contact[product_interest]': 'Sofa', 'contact[quantity]': '-5',
    'contact[reference_link]': 'javascript:alert(1)',
  }));
  assert.equal(r.ok, true);
  assert.equal(r.value.projectType, ''); assert.equal(r.value.productInterest, '');
  assert.equal(r.value.quantity, null); assert.equal(r.value.referenceLink, '');
});

test('parseEnquiryFields: long text is truncated and control chars removed', () => {
  const r = parseEnquiryFields(good({ 'contact[body]': 'a\u0000b'.repeat(3000) }));
  assert.equal(r.value.body.length, 2000);
  assert.ok(!r.value.body.includes('\u0000'));
});

test('buildDescription lists only the facts that were given', () => {
  const full = buildDescription(parseEnquiryFields(good()).value);
  assert.match(full, /^40 dining chairs/);
  assert.match(full, /Project type: Hospitality/);
  assert.match(full, /Quantity: 40/);
  const rich = buildDescription(parseEnquiryFields(good({
    'contact[company]': 'Villa Rosa', 'contact[location]': 'Westlands', 'contact[utm_source]': 'google', 'contact[utm_medium]': 'cpc',
    'contact[landing_page]': 'https://theseatingcompany.co.ke/collections/dining',
  })).value);
  assert.match(rich, /Company \/ venue: Villa Rosa/);
  assert.match(rich, /Location: Westlands/);
  assert.match(rich, /Came from: google \/ cpc/);
  assert.match(rich, /Landing page: https:\/\/theseatingcompany\.co\.ke\/collections\/dining/);
  const bare = buildDescription(parseEnquiryFields(good({
    'contact[project_type]': '', 'contact[product_interest]': '', 'contact[quantity]': '', 'contact[budget]': '', 'contact[reference_link]': '',
  })).value);
  assert.equal(bare, '40 dining chairs for a restaurant');
});
