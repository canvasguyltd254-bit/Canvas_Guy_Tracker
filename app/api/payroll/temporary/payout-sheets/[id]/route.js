/**
 * GET   /api/payroll/temporary/payout-sheets/:id   sheet + its settlements, deductions and workers (for printing)
 * PATCH /api/payroll/temporary/payout-sheets/:id   { action: approve | print | cancel | receipt_init | receipt_complete | receipt_url }
 *
 * The signed receipt goes browser -> private storage bucket via a signed upload URL (a phone photo can exceed
 * the 4.5 MB request limit); receipt_complete then verifies the object exists before the database records it.
 */
import { NextResponse } from 'next/server';
import { guard, rpc, bad, readJson, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import {
  SHEET_COLUMNS, SETTLEMENT_COLUMNS, DEDUCTION_COLUMNS, RECEIPT_BUCKET, RECEIPT_EXTENSIONS, RECEIPT_MAX_BYTES, isUuid,
} from '@/shared/lib/payroll/temporaryAccess';

const safeName = (n) => String(n).replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase().slice(-80);

export async function GET(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const { data: sheet, error } = await serviceClient.from('temporary_worker_payout_sheets').select(SHEET_COLUMNS).eq('id', id).single();
  if (error || !sheet) return NextResponse.json({ error: 'Payout sheet not found' }, { status: 404 });
  const { data: settlements, error: sErr } = await serviceClient.from('temporary_worker_settlements')
    .select(`${SETTLEMENT_COLUMNS}, employees(name, employee_num), temporary_worker_engagements(engagement_num)`)
    .eq('payout_sheet_id', id).order('settlement_num');
  if (sErr) return dbError(sErr);
  const ids = (settlements || []).map(s => s.id);
  let deductions = [];
  if (ids.length) {
    const { data: d, error: dErr } = await serviceClient.from('temporary_worker_settlement_deductions')
      .select(DEDUCTION_COLUMNS).in('settlement_id', ids).eq('active', true).order('recorded_at');
    if (dErr) return dbError(dErr);
    deductions = d || [];
  }
  return NextResponse.json({ sheet, settlements: settlements || [], deductions });
}

export async function PATCH(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const b = await readJson(request);
  const who = { p_actor: g.user.id, p_role: g.role };
  const prefix = `sheets/${id}/`;

  switch (b.action) {
    case 'approve': return rpc('approve_payout_sheet', { p_id: id, ...who });
    case 'print':   return rpc('mark_sheet_printed', { p_id: id, ...who });
    case 'cancel':  return rpc('cancel_payout_sheet', { p_id: id, p_reason: String(b.reason || ''), ...who });

    case 'receipt_init': {
      const name = String(b.file_name || ''); const size = Number(b.file_size);
      if (!name || !RECEIPT_EXTENSIONS.some(e => name.toLowerCase().endsWith(e))) return bad('Upload a PDF, PNG, JPG or HEIC photo of the signed sheet.');
      if (!Number.isFinite(size) || size <= 0 || size > RECEIPT_MAX_BYTES) return bad('The file must be under 15 MB.');
      const { data: sheet } = await serviceClient.from('temporary_worker_payout_sheets').select('status').eq('id', id).single();
      if (!sheet) return NextResponse.json({ error: 'Payout sheet not found' }, { status: 404 });
      if (sheet.status !== 'printed') return bad('Print the payout sheet before attaching the signed copy.', 'RULE');
      // Private bucket; creating it is idempotent (an "already exists" error after the first time is expected).
      await serviceClient.storage.createBucket(RECEIPT_BUCKET, { public: false });
      const path = `${prefix}${Date.now()}-${safeName(name)}`;
      const { data, error } = await serviceClient.storage.from(RECEIPT_BUCKET).createSignedUploadUrl(path);
      if (error || !data) { console.error('receipt signed upload:', error); return NextResponse.json({ error: 'Could not start the upload' }, { status: 500 }); }
      return NextResponse.json({ success: true, path: data.path, token: data.token, bucket: RECEIPT_BUCKET });
    }
    case 'receipt_complete': {
      const path = String(b.path || '');
      if (!path.startsWith(prefix) || path.includes('..')) return bad('Invalid upload reference.');
      const objName = path.slice(prefix.length);
      const { data: found } = await serviceClient.storage.from(RECEIPT_BUCKET).list(prefix.slice(0, -1), { search: objName, limit: 1 });
      const obj = found?.find(o => o.name === objName);
      if (!obj) return bad('The uploaded file was not found. Try again.');
      if (Number(obj.metadata?.size ?? 0) > RECEIPT_MAX_BYTES) {
        await serviceClient.storage.from(RECEIPT_BUCKET).remove([path]);
        return bad('The file must be under 15 MB.');
      }
      return rpc('attach_signed_receipt', { p_id: id, p_path: path, ...who });
    }
    case 'receipt_url': {
      const { data: sheet } = await serviceClient.from('temporary_worker_payout_sheets').select('signed_receipt_path').eq('id', id).single();
      if (!sheet?.signed_receipt_path) return NextResponse.json({ error: 'No signed receipt on this sheet' }, { status: 404 });
      const { data, error } = await serviceClient.storage.from(RECEIPT_BUCKET).createSignedUrl(sheet.signed_receipt_path, 600);
      if (error || !data) return NextResponse.json({ error: 'Could not open the receipt' }, { status: 500 });
      return NextResponse.json({ url: data.signedUrl });
    }
    default: return bad('Unknown action');
  }
}
