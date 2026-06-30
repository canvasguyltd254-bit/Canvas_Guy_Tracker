/**
 * app/api/orders/[id]/documents/route.js
 *
 * GET    /api/orders/:id/documents                   — list documents (any authenticated user)
 * POST   /api/orders/:id/documents  (multipart)      — upload document
 * DELETE /api/orders/:id/documents?document_id=...   — delete document (admin + production_manager)
 *
 * Storage bucket: order-documents
 */

// NOTE: intentionally NOT edge runtime — this route handles multipart file uploads
// up to 50MB. Edge Runtime enforces a 4MB body limit which would break uploads.
// Auth overhead is acceptable here since uploads are infrequent.

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

const STORAGE_BUCKET = 'order-documents';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const UPLOAD_ROLES = ['admin', 'production_manager', 'head_of_sales', 'sales', 'production_staff'];
const DELETE_ROLES = ['admin', 'production_manager'];

export async function GET(request, { params }) {
  try {
    const orderId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role); // any authenticated user
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('order_documents')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('GET /api/orders/[id]/documents:', error);
      return NextResponse.json({ error: 'Failed to fetch documents' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });

  } catch (err) {
    console.error('GET /api/orders/[id]/documents:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const orderId = params.id;

    // 1. Auth
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, UPLOAD_ROLES);
    if (authError) return authError;

    // 2. Parse multipart form data
    let formData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
    }

    const file = formData.get('file');
    const docType = formData.get('doc_type') || 'Other';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File exceeds 50MB limit' }, { status: 400 });
    }

    // 3. Verify order exists
    const { data: order } = await serviceClient
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .single();

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // 4. Upload to storage
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
    const storagePath = `${orderId}/${timestamp}-${safeName}`;
    const buffer = await file.arrayBuffer();

    const { error: uploadError } = await serviceClient.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, {
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
      });

    if (uploadError) {
      console.error('POST /api/orders/[id]/documents — storage upload:', uploadError);
      return NextResponse.json({ error: 'Failed to upload file to storage' }, { status: 500 });
    }

    // 5. Insert DB record — order_id injected server-side, pick() applied
    const docRaw = {
      order_id: orderId,       // injected server-side
      name: file.name,
      doc_type: docType,
      file_path: storagePath,
      file_size: file.size,
    };

    const safeDoc = pick(docRaw, ALLOWED_FIELDS.order_documents.insert);

    const { data, error: insertError } = await serviceClient
      .from('order_documents')
      .insert(safeDoc)
      .select()
      .single();

    if (insertError) {
      console.error('POST /api/orders/[id]/documents — db insert:', insertError);
      // Clean up orphaned file
      await serviceClient.storage.from(STORAGE_BUCKET).remove([storagePath]);
      return NextResponse.json({ error: 'Failed to save document record' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data }, { status: 201 });

  } catch (err) {
    console.error('POST /api/orders/[id]/documents:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const orderId = params.id;
    const { searchParams } = new URL(request.url);
    const documentId = searchParams.get('document_id');

    if (!documentId) {
      return NextResponse.json({ error: 'Missing document_id query param' }, { status: 400 });
    }

    // 1. Auth
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, DELETE_ROLES);
    if (authError) return authError;

    // 2. Fetch document (scoped to this order)
    const { data: doc } = await serviceClient
      .from('order_documents')
      .select('id, file_path, order_id')
      .eq('id', documentId)
      .eq('order_id', orderId)
      .single();

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // 3. Delete from storage
    await serviceClient.storage.from(STORAGE_BUCKET).remove([doc.file_path]);

    // 4. Delete DB record
    const { error } = await serviceClient
      .from('order_documents')
      .delete()
      .eq('id', documentId)
      .eq('order_id', orderId);

    if (error) {
      console.error('DELETE /api/orders/[id]/documents:', error);
      return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Document deleted' });

  } catch (err) {
    console.error('DELETE /api/orders/[id]/documents:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
