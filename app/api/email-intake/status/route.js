/**
 * GET /api/email-intake/status
 *
 * Reports whether each mailbox is configured (which env var NAMES are
 * missing — never values), whether CRON_SECRET is set, and when an email was
 * last queued per brand. It does NOT open an IMAP connection, so it cannot
 * say a login is valid — only that it is present. "Last queued" is a proxy:
 * automated mail is skipped, so a quiet mailbox is not proof of a failure.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { loadMailboxes, toPublicStatus, isCronSecretConfigured } from '@/shared/lib/emailIntake/mailboxConfig';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    const mailboxes = toPublicStatus(await loadMailboxes(serviceClient));
    for (const m of mailboxes) {
      const { data } = await serviceClient
        .from('inbound_emails')
        .select('created_at')
        .eq('brand', m.brand)
        .order('created_at', { ascending: false })
        .limit(1);
      m.last_queued_at = data?.[0]?.created_at ?? null;
    }

    return NextResponse.json({
      success: true,
      data: { mailboxes, cron_secret_configured: isCronSecretConfigured() },
    });
  } catch (err) {
    console.error('GET /api/email-intake/status:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
