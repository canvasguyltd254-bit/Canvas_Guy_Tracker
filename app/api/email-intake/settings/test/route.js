/**
 * POST /api/email-intake/settings/test   (ADMIN ONLY)
 * Body: { brand }
 * Tests the SAVED/resolved login for that brand by logging in and out. Reads
 * no mail and changes no flags.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { loadMailboxes } from '@/shared/lib/emailIntake/mailboxConfig';
import { testImapLogin } from '@/shared/lib/emailIntake/testImapLogin';

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ['admin']);
    if (authErr) return authErr;

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const mb = (await loadMailboxes(serviceClient)).find((m) => m.brand === body?.brand);
    if (!mb) return NextResponse.json({ error: 'Unknown mailbox brand' }, { status: 400 });
    if (!mb.configured) return NextResponse.json({ success: true, data: { ok: false, reason: 'config', message: mb.error || 'No login saved for this mailbox yet.' } });

    const result = await testImapLogin({ host: mb.host, port: mb.port, secure: mb.secure, user: mb.user, pass: mb.pass });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/email-intake/settings/test:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
