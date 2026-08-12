/**
 * app/api/crm/enquiries/report/route.js
 *
 * GET /api/crm/enquiries/report
 *   ?stage=<stage>   optional filter
 *   ?q=<search>      optional search
 *   ?month=YYYY-MM   optional month filter (e.g. 2026-08)
 *
 * Returns a PDF of all enquiries with won/lost summary per month.
 * Roles: admin, head_of_sales, sales
 */

export const runtime = 'nodejs';

import { NextResponse }  from 'next/server';
import { spawn }         from 'child_process';
import path              from 'path';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES = ['admin', 'head_of_sales', 'sales'];

export async function GET(request) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authErr = requireRole(user, role, ROLES);
    if (authErr) return authErr;

    const { searchParams } = new URL(request.url);
    const stageFilter = searchParams.get('stage') || '';
    const qFilter     = searchParams.get('q')     || '';
    const monthFilter = searchParams.get('month') || '';

    // Build query
    let query = serviceClient
      .from('enquiries')
      .select(`
        id, enq_num, stage, source, description, category,
        estimated_value, lost_reason, created_at, updated_at,
        prospect_name, prospect_contact,
        customers ( name, phone )
      `)
      .order('created_at', { ascending: false });

    if (stageFilter) query = query.eq('stage', stageFilter);
    if (qFilter) {
      query = query.or(
        `enq_num.ilike.%${qFilter}%,description.ilike.%${qFilter}%,prospect_name.ilike.%${qFilter}%`
      );
    }
    if (monthFilter) {
      const [yr, mo] = monthFilter.split('-').map(Number);
      const from = new Date(yr, mo - 1, 1).toISOString();
      const to   = new Date(yr, mo, 1).toISOString();
      query = query.gte('created_at', from).lt('created_at', to);
    }

    const { data: enquiries, error } = await query;
    if (error) {
      console.error('GET /api/crm/enquiries/report:', error);
      return NextResponse.json({ error: 'Failed to fetch enquiries' }, { status: 500 });
    }

    // Build monthly summary
    const monthMap = {};
    for (const e of enquiries) {
      const m = e.created_at?.slice(0, 7) || 'Unknown';
      if (!monthMap[m]) monthMap[m] = { won: 0, lost: 0, new: 0, contacted: 0, quoted: 0, total: 0 };
      monthMap[m][e.stage] = (monthMap[m][e.stage] || 0) + 1;
      monthMap[m].total += 1;
    }
    const monthlySummary = Object.entries(monthMap)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([month, counts]) => ({ month, ...counts }));

    // Flatten enquiry rows for the report
    const rows = enquiries.map(e => ({
      enq_num:         e.enq_num || '—',
      customer:        e.customers?.name || e.prospect_name || '—',
      description:     e.description || '—',
      category:        e.category || '—',
      source:          e.source || '—',
      stage:           e.stage,
      estimated_value: e.estimated_value ? String(e.estimated_value) : '0',
      lost_reason:     e.lost_reason || '',
      created_at:      e.created_at || '',
    }));

    const payload = JSON.stringify({
      reportType:     'enquiryReport',
      reportLabel:    stageFilter ? `Enquiries — ${stageFilter}` : 'All Enquiries',
      month:          monthFilter,
      rows,
      monthlySummary,
      userName:       displayName || user.email || '',
      dateFrom:       null,
      dateTo:         null,
    });

    // Spawn build_report.js (Node/pdfkit — the active generator)
    const scriptPath = path.join(process.cwd(), 'scripts', 'run_report.js');
    const pdf = await new Promise((resolve, reject) => {
      const proc   = spawn('node', [scriptPath]);
      const chunks = [];
      proc.stdout.on('data', d => chunks.push(d));
      proc.stderr.on('data', d => console.error('[enquiry-report]', d.toString()));
      proc.on('close', code => {
        if (code !== 0) return reject(new Error(`run_report.js exited ${code}`));
        resolve(Buffer.concat(chunks));
      });
      proc.stdin.write(payload);
      proc.stdin.end();
    });

    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': 'attachment; filename="enquiry-report.pdf"',
      },
    });

  } catch (err) {
    console.error('GET /api/crm/enquiries/report:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
