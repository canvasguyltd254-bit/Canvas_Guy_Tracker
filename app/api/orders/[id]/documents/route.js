import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const STORAGE_BUCKET = 'order-documents';

// ── GET — signed URL for viewing/downloading a document ──────────────────────
export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const docId = searchParams.get('doc_id');
    if (!docId) {
      return NextResponse.json({ error: 'Missing doc_id' }, { status: 400 });
    }

    // Fetch doc metadata to get file_path
    const { data: doc, error } = await serviceClient
      .from('order_documents')
      .select('file_path, name')
      .eq('id', docId)
      .single();

    if (error || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Generate signed URL via service role (bypasses RLS)
    const { data: signedUrlData, error: signedUrlError } = await serviceClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(doc.file_path, 3600);

    if (signedUrlError) {
      console.error('Signed URL error:', signedUrlError);
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
