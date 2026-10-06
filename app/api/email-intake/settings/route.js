/**
 * /api/email-intake/settings   (ADMIN ONLY)
 *
 *   GET     — per-brand status (never the password) + whether encryption is set up
 *   PUT     — save a brand's login. Blank password = keep the stored one, but only
 *             if host and username are unchanged (a stored password is never sent
 *             to a different server or account).
 *   DELETE  ?brand=…  — remove the stored login (env vars, if any, apply again)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { loadMailboxes, toPublicStatus, MAILBOXES } from '@/shared/lib/emailIntake/mailboxConfig';
import { encryptSecret, isEncryptionConfigured } from '@/shared/lib/emailIntake/credentialCrypto';
import { validateMailboxInput } from '@/shared/lib/emailIntake/validateMailboxInput';

async function adminOnly() {
  const { user, role } = await getAuthContext();
  if (!user) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const authErr = requireRole(user, role, ['admin']);
  if (authErr) return { res: authErr };
  return { user };
}

export async function GET() {
  try {
    const a = await adminOnly(); if (a.res) return a.res;
    return NextResponse.json({
      success: true,
      data: {
        mailboxes: toPublicStatus(await loadMailboxes(serviceClient)),
        encryption_configured: isEncryptionConfigured(),
      },
    });
  } catch (err) {
    console.error('GET /api/email-intake/settings:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const a = await adminOnly(); if (a.res) return a.res;

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const v = validateMailboxInput(body);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    const { brand, host, port, secure, username, password } = v.value;

    if (!isEncryptionConfigured()) {
      return NextResponse.json({ error: 'EMAIL_CREDENTIALS_KEY is not set on the server, so passwords cannot be stored safely. Add it first.' }, { status: 409 });
    }

    const { data: existing } = await serviceClient
      .from('email_mailbox_settings')
      .select('host, username, password_encrypted')
      .eq('brand', brand)
      .maybeSingle();

    let password_encrypted;
    if (password) {
      password_encrypted = encryptSecret(password);
    } else if (existing && existing.host === host && existing.username === username) {
      password_encrypted = existing.password_encrypted;   // unchanged login → keep
    } else {
      return NextResponse.json({ error: 'Enter the password (it is required when adding a login or changing the server or username).' }, { status: 400 });
    }

    const { error } = await serviceClient
      .from('email_mailbox_settings')
      .upsert({ brand, host, port, secure, username, password_encrypted, updated_by: a.user.id, updated_at: new Date().toISOString() });
    if (error) {
      console.error('PUT /api/email-intake/settings:', error);
      return NextResponse.json({ error: 'Failed to save mailbox login' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('PUT /api/email-intake/settings:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const a = await adminOnly(); if (a.res) return a.res;
    const brand = new URL(request.url).searchParams.get('brand');
    if (!MAILBOXES.some((m) => m.brand === brand)) return NextResponse.json({ error: 'Unknown mailbox brand' }, { status: 400 });
    const { error } = await serviceClient.from('email_mailbox_settings').delete().eq('brand', brand);
    if (error) {
      console.error('DELETE /api/email-intake/settings:', error);
      return NextResponse.json({ error: 'Failed to remove mailbox login' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/email-intake/settings:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
