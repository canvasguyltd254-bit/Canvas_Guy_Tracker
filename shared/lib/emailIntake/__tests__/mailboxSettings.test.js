import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../credentialCrypto.js';
import { resolveMailboxes, toPublicStatus } from '../mailboxConfig.js';
import { validateMailboxInput } from '../validateMailboxInput.js';

const KEY = crypto.randomBytes(32).toString('base64');
const ENV = { EMAIL_CREDENTIALS_KEY: KEY };

describe('credentialCrypto', () => {
  test('round-trips and never stores plaintext', () => {
    const enc = encryptSecret('s3cret pass!', ENV);
    assert.match(enc, /^v1:/);
    assert.ok(!enc.includes('s3cret'));
    assert.equal(decryptSecret(enc, ENV), 's3cret pass!');
  });
  test('fresh IV each time', () => {
    assert.notEqual(encryptSecret('x', ENV), encryptSecret('x', ENV));
  });
  test('wrong key and tampering are rejected', () => {
    const enc = encryptSecret('abc', ENV);
    assert.throws(() => decryptSecret(enc, { EMAIL_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64') }));
    const parts = enc.split(':'); parts[3] = Buffer.from('zzzz').toString('base64');
    assert.throws(() => decryptSecret(parts.join(':'), ENV));
  });
  test('missing / short key is refused', () => {
    assert.throws(() => encryptSecret('a', {}), /KEY_MISSING/);
    assert.throws(() => encryptSecret('a', { EMAIL_CREDENTIALS_KEY: 'c2hvcnQ=' }), /KEY_INVALID/);
    assert.equal(isEncryptionConfigured({}), false);
    assert.equal(isEncryptionConfigured(ENV), true);
  });
});

describe('resolveMailboxes', () => {
  const row = (pw) => ({ host: 'imap.example.com', port: 993, secure: true, username: 'a@x.com', password_encrypted: encryptSecret(pw, ENV) });

  test('stored login wins over env and is decrypted', () => {
    const env = { ...ENV, EMAIL_CANVAS_GUY_HOST: 'envhost.com', EMAIL_CANVAS_GUY_USER: 'e', EMAIL_CANVAS_GUY_PASS: 'envpass' };
    const m = resolveMailboxes({ canvas_guy: row('dbpass') }, env).find((x) => x.brand === 'canvas_guy');
    assert.equal(m.source, 'database'); assert.equal(m.pass, 'dbpass'); assert.equal(m.host, 'imap.example.com');
  });
  test('falls back to env when no stored row', () => {
    const env = { EMAIL_SEATING_COMPANY_HOST: 'h.com', EMAIL_SEATING_COMPANY_USER: 'u', EMAIL_SEATING_COMPANY_PASS: 'p' };
    const m = resolveMailboxes({}, env).find((x) => x.brand === 'seating_company');
    assert.equal(m.source, 'environment'); assert.equal(m.configured, true);
  });
  test('reports missing env names when nothing is set', () => {
    const m = resolveMailboxes({}, {}).find((x) => x.brand === 'canvas_guy');
    assert.equal(m.configured, false);
    assert.deepEqual(m.missing, ['EMAIL_CANVAS_GUY_HOST', 'EMAIL_CANVAS_GUY_USER', 'EMAIL_CANVAS_GUY_PASS']);
  });
  test('undecryptable stored row is an error and does NOT fall back to env', () => {
    const env = { EMAIL_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64'), EMAIL_CANVAS_GUY_HOST: 'h.com', EMAIL_CANVAS_GUY_USER: 'u', EMAIL_CANVAS_GUY_PASS: 'p' };
    const m = resolveMailboxes({ canvas_guy: row('x') }, env).find((x) => x.brand === 'canvas_guy');
    assert.equal(m.configured, false); assert.ok(m.error); assert.equal(m.source, 'database');
  });
  test('public status never contains the password', () => {
    const out = toPublicStatus(resolveMailboxes({ canvas_guy: row('topsecret') }, ENV));
    assert.ok(!JSON.stringify(out).includes('topsecret'));
    assert.ok(!('pass' in out[0]));
  });
});

describe('validateMailboxInput', () => {
  const ok = { brand: 'canvas_guy', host: 'imap.gmail.com', port: 993, username: 'holla@canvasguy.co.ke', password: 'x' };
  test('accepts a normal login', () => assert.equal(validateMailboxInput(ok).ok, true));
  test('rejects unknown brand', () => assert.equal(validateMailboxInput({ ...ok, brand: 'other' }).ok, false));
  test('rejects local / private / IP hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254', 'db.internal', 'x.local', '[::1]', 'nodots'])
      assert.equal(validateMailboxInput({ ...ok, host }).ok, false, host);
  });
  test('rejects odd ports and bad usernames', () => {
    assert.equal(validateMailboxInput({ ...ok, port: 25 }).ok, false);
    assert.equal(validateMailboxInput({ ...ok, username: 'not an@email' }).ok, false);
  });
  test('secure follows the port', () => {
    assert.equal(validateMailboxInput(ok).value.secure, true);
    assert.equal(validateMailboxInput({ ...ok, port: 143 }).value.secure, false);
  });
});
