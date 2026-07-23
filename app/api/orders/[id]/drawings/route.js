// NOTE: intentionally NOT edge runtime — this route handles multipart file uploads
// up to 70MB. Edge Runtime enforces a 4MB body limit which would break uploads.

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

const ALLOWED_EXTENSIONS = ['.pdf', '.dxf', '.png', '.jpg', '.jpeg'];
const MAX_FILE_SIZE = 70 * 1024 * 1024; // 70MB
const STORAGE_BUCKET = 'order-drawings';

// ── File helpers ──────────────────────────────────────────────────────────────

function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: 'File too large. Maximum 70MB allowed.' };
  }
  const name = file.name.toLowerCase();
  const hasValidExt = ALLOWED_EXTENSIONS.some(ext => name.endsWith(ext));
  if (!hasValidExt) {
    return { valid: false, error: 'Invalid file type. Allowed: DXF, PDF, PNG, JPG.' };
  }
  return { valid: true };
}

function generateSafeFileName(originalName) {
  const timestamp = Date.now();
  const safe = originalName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\s+/g, '_')
    .toLowerCase();
  const ext = safe.substring(safe.lastIndexOf('.'));
  const base = safe.substring(0, safe.lastIndexOf('.'));
  return `${timestamp}-${base}${ext}`;
}

function getDrawingType(fileName) {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'dxf') return 'dxf';
  if (['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) return 'specification';
  return 'general';
}

// ── GET — signed URL for download ─────────────────────────────────────────────

export async function GET(request, { params }) {
  try {
    // 1. Verify user from cookies
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const drawingId = searchParams.get('drawing_id');
    if (!drawingId) {
      return NextResponse.json({ error: 'Missing drawing_id' }, { status: 400 });
    }

    // 2. Fetch drawing metadata via service client
    const { data: drawing, error } = await serviceClient
      .from('drawings')
      .select('file_path, file_name, deleted_at')
      .eq('id', drawingId)
      .single();

    if (error || !drawing) {
      return NextResponse.json({ error: 'Drawing not found' }, { status: 404 });
    }
    if (drawing.deleted_at) {
      return NextResponse.json({ error: 'Drawing has been deleted' }, { status: 410 });
    }

    // 3. Generate signed URL (1 hour)
    const { data: signedUrlData, error: signedUrlError } = await serviceClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(drawing.file_path, 3600);

    if (signedUrlError) {
      console.error('Signed URL error:', signedUrlError);
      return NextResponse.json({ error: 'Failed to generate download URL' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      signed_url: signedUrlData.signedUrl,
      file_name: drawing.file_name,
    });

  } catch (err) {
    console.error('GET /api/orders/[id]/drawings:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST — upload drawing ─────────────────────────────────────────────────────

export async function POST(request, { params }) {
  try {
    const orderId = params.id;

    // 1. Verify user from cookies
    const { user, role, displayName } = await getAuthContext();
    const uploadRoles = ['admin', 'production_manager', 'head_of_sales', 'sales', 'production_staff'];
    const authError = requireRole(user, role, uploadRoles);
    if (authError) return authError;

    // 3. Verify order exists (service client bypasses RLS)
    const { data: order } = await serviceClient
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .single();
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // 4. Parse file from FormData
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // 5. Validate file
    const validation = validateFile(file);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // 6. Upload to Supabase Storage via service client
    const safeFileName = generateSafeFileName(file.name);
    const storagePath = `orders/${orderId}/drawings/${safeFileName}`;
    const buffer = await file.arrayBuffer();

    const { error: uploadError } = await serviceClient.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, {
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return NextResponse.json({ error: 'Failed to upload file to storage' }, { status: 500 });
    }

    // 7. Insert metadata — server-side fields injected; pick() strips any extras
    const rawInsert = {
      order_id: orderId,           // injected server-side
      file_name: file.name,
      file_path: storagePath,
      file_size: file.size,
      mime_type: file.type || 'application/octet-stream',
      drawing_type: getDrawingType(file.name),
      uploaded_by: user.id,        // injected from verified session, never from body
      uploaded_at: new Date().toISOString(),
    };
    const safeInsert = pick(rawInsert, ALLOWED_FIELDS.drawings.insert);

    const { data: drawing, error: insertError } = await serviceClient
      .from('drawings')
      .insert(safeInsert)
      .select()
      .single();

    if (insertError) {
      console.error('DB insert error:', insertError);
      // Clean up orphaned storage file
      await serviceClient.storage.from(STORAGE_BUCKET).remove([storagePath]);
      return NextResponse.json({ error: 'Failed to save file metadata' }, { status: 500 });
    }

    // 8. Return signed URL for immediate display
    const { data: signedUrlData } = await serviceClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, 3600);

    return NextResponse.json({
      success: true,
      drawing: {
        id: drawing.id,
        order_id: drawing.order_id,
        file_name: drawing.file_name,
        file_path: drawing.file_path,
        file_size: drawing.file_size,
        mime_type: drawing.mime_type,
        drawing_type: drawing.drawing_type,
        uploaded_at: drawing.uploaded_at,
        deleted_at: null,
        signed_url: signedUrlData?.signedUrl || null,
      },
    });

  } catch (err) {
    console.error('POST /api/orders/[id]/drawings:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE — soft delete ──────────────────────────────────────────────────────

export async function DELETE(request, { params }) {
  try {
    const orderId = params.id;
    const { searchParams } = new URL(request.url);
    const drawingId = searchParams.get('drawing_id');

    if (!drawingId) {
      return NextResponse.json({ error: 'Missing drawing_id' }, { status: 400 });
    }

    // 1. Verify user from cookies
    const { user, role, displayName } = await getAuthContext();
    const deleteRoles = ['admin', 'production_manager', 'head_of_sales'];
    const authError = requireRole(user, role, deleteRoles);
    if (authError) return authError;

    // 2. Require a deletion reason
    let reason = '';
    try {
      const body = await request.json();
      reason = (body?.reason || '').trim();
    } catch { /* body may not be parseable */ }
    if (!reason) {
      return NextResponse.json({ error: 'A reason is required to delete a file' }, { status: 400 });
    }

    // 3. Verify drawing belongs to this order (also fetch file_name for the log)
    const { data: drawing } = await serviceClient
      .from('drawings')
      .select('id, order_id, deleted_at, file_name')
      .eq('id', drawingId)
      .eq('order_id', orderId)
      .single();

    if (!drawing) {
      return NextResponse.json({ error: 'Drawing not found' }, { status: 404 });
    }
    if (drawing.deleted_at) {
      return NextResponse.json({ error: 'Drawing already deleted' }, { status: 400 });
    }

    // 4. Soft delete — file stays in storage for recovery
    const { error } = await serviceClient
      .from('drawings')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', drawingId)
      .is('deleted_at', null);

    if (error) {
      return NextResponse.json({ error: 'Failed to delete drawing' }, { status: 500 });
    }

    // 5. Log to order_activities — best-effort
    const { error: actError } = await serviceClient.from('order_activities').insert({
      order_id:      orderId,
      activity_type: 'file_deleted',
      description:   `File "${drawing.file_name}" deleted by ${displayName}. Reason: ${reason}`,
      created_by:    user.id,
    });
    if (actError) {
      console.error('DELETE /api/orders/[id]/drawings — activity log failed:', actError.message);
    }

    return NextResponse.json({
      success:         true,
      message:         'Drawing deleted successfully',
      activity_logged: !actError,
    });

  } catch (err) {
    console.error('DELETE /api/orders/[id]/drawings:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
