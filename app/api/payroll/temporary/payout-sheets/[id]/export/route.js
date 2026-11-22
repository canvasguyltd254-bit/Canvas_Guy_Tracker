/**
 * POST /api/payroll/temporary/payout-sheets/:id/export
 *
 * Returns the ChatPesa bulk-payment CSV for the sheet (same 9-column format as regular payroll batches). Admin only.
 *
 * The FIRST call freezes the rows and marks the sheet exported; later calls return only rows that are still unpaid and are
 * logged, because uploading the same file twice pays twice. Every rule (approval limit, valid phone, preparer != releaser)
 * lives in export_payout_sheet; this route only turns its rows into a file.
 *
 * POST, not GET: it changes state, so a browser prefetch or link preview must never trigger it.
 */
import { NextResponse } from 'next/server';
import { guard, bad, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import { isUuid, buildChatpesaCsv } from '@/shared/lib/payroll/temporaryAccess';

export async function POST(request, props) {
  const { id } = await props.params;
  const g = await guard(['admin']); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');

  const { data, error } = await serviceClient.rpc('export_payout_sheet', { p_id: id, p_actor: g.user.id, p_role: g.role });
  if (error) return dbError(error);
  let csv;
  try { csv = buildChatpesaCsv(data?.rows); }
  catch (e) { console.error('temporary payout export: invalid row', e?.message); return NextResponse.json({ error: 'A payout row is invalid. Nothing was uploaded.', code: 'INTERNAL' }, { status: 500 }); }

  const filename = `chatpesa_${data.sheet_num}_${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-First-Export': data.first_export ? '1' : '0',
    },
  });
}
