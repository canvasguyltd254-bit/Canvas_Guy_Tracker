/**
 * GET  /api/orders/:id/documents?doc_id  — signed URL for viewing/downloading
 * DELETE /api/orders/:id/documents?doc_id — delete with required reason (admin, production_manager, head_of_sales)
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const STORAGE_BUCKET = 'order-documents';
const DOC_DELETE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

// ── GET — signed URL for viewing/downloading a document ──────────────────────
export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const orderId = params.id;
    const { searchParams } = new URL(request.url);
    const docId = searchParams.get('doc_id');
    if (!docId) {
      return NextResponse.json({ error: 'Missing doc_id' }, { status: 400 });
    }

    // Fetch doc metadata — verify it belongs to this order
    const { data: doc, error } = await serviceClient
      .from('order_documents')
      .select('file_path, name')
      .eq('id', docId)
      .eq('order_id', orderId)
      .single();

    if (error || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Generate signed URL via service role (bypasses RLS)
    const { data: signedUrlData, error: signedUrlError } = await serviceClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(doc.file_path, 3600);

    if (signedUrlError) {
      console.error('Documents GET — signed URL error:', signedUrlError);
      return NextResponse.json({ error: 'Failed to generate download URL' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      signed_url: signedUrlData.signedUrl,
      file_name: doc.name,
    });

  } catch (err) {
    console.error('Documents GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE — remove document + storage file ───────────────────────────────────
export async function DELETE(request, { params }) {
  try {
    const orderId = params.id;
    const { searchParams } = new URL(request.url);
    const docId = searchParams.get('doc_id');

    if (!docId) {
      return NextResponse.json({ error: 'Missing doc_id query param' }, { status: 400 });
    }

    // 1. Auth
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, DOC_DELETE_ROLES);
    if (authError) return authError;

    // 2. Require a reason
    let reason = '';
    try {
      const body = await request.json();
      reason = (body?.reason || '').trim();
    } catch { /* body may be absent */ }
    if (!reason) {
      return NextResponse.json({ error: 'A reason is required to delete a document' }, { status: 400 });
    }

    // 3. Fetch document — verify it belongs to this order
    const { data: doc, error: fetchErr } = await serviceClient
      .from('order_documents')
      .select('id, order_id, name, file_path')
      .eq('id', docId)
      .eq('order_id', orderId)
      .single();

    if (fetchErr || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // 4. Delete DB record first — if this fails, the storage file is still intact
    const { error: dbErr } = await serviceClient
      .from('order_documents')
      .delete()
      .eq('id', docId)
      .eq('order_id', orderId);

    if (dbErr) {
      console.error('DELETE /api/orders/[id]/documents — DB delete error:', dbErr.message);
      return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 });
    }

    // 5. Remove from storage (best-effort — DB record already gone, log but don't fail)
    const { error: storageErr } = await serviceClient.storage
      .from(STORAGE_BUCKET)
      .remove([doc.file_path]);
    if (storageErr) {
      console.error('DELETE /api/orders/[id]/documents — storage remove error:', storageErr.message);
    }

    // 6. Activity log — best-effort
    const { error: actError } = await serviceClient.from('order_activities').insert({
      order_id:      orderId,
      activity_type: 'file_deleted',
      description:   `Document "${doc.name}" deleted by ${displayName}. Reason: ${reason}`,
      created_by:    user.id,
    });
    if (actError) {
      console.error('DELETE /api/orders/[id]/documents — activity log failed:', actError.message);
    }

    return NextResponse.json({
      success:         true,
      message:         'Document deleted',
      activity_logged: !actError,
    });

  } catch (err) {
    console.error('DELETE /api/orders/[id]/documents — unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
