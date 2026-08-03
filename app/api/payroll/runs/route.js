/**
 * GET  /api/payroll/runs  — list payroll runs
 * POST /api/payroll/runs  — create a new payroll run
 *
 * Access: admin, production_manager
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const TYPE_ABBREV = { casual: 'CA', permanent: 'PE', skilled_casual: 'SK', combined: 'CO' };

/** Returns ISO week number (1–53) for a YYYY-MM-DD string. */
function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;          // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // shift to Thursday of the same week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/** Builds PR-YYYY-CA-026 style run number. Returns null if the number already exists. */
async function buildRunNum(run_type, period_start) {
  const year   = new Date(period_start + 'T00:00:00Z').getUTCFullYear();
  const week   = getISOWeek(period_start);
  const abbrev = TYPE_ABBREV[run_type] || 'XX';
  const run_num = `PR-${year}-${abbrev}-${String(week).padStart(3, '0')}`;

  // Check uniqueness
  const { count } = await serviceClient
    .from('payroll_runs')
    .select('id', { count: 'exact', head: true })
    .eq('run_num', run_num);

  return count > 0 ? null : run_num;
}

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const status      = searchParams.get('status');
    const run_type    = searchParams.get('run_type');
    const period_type = searchParams.get('period_type');
    const limit       = parseInt(searchParams.get('limit') || '50');
    const offset      = parseInt(searchParams.get('offset') || '0');

    let query = serviceClient
      .from('payroll_runs')
      .select('*', { count: 'exact' })
      .order('period_start', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status)      query = query.eq('status', status);
    if (run_type)    query = query.eq('run_type', run_type);
    if (period_type) query = query.eq('period_type', period_type);

    const { data: runs, error, count } = await query;
    if (error) {
      console.error('GET /api/payroll/runs error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch payroll runs' }, { status: 500 });
    }

    // Aggregate totals per run in one query
    const runIds = (runs || []).map(r => r.id);
    let totalsMap = {};
    if (runIds.length > 0) {
      const { data: entries } = await serviceClient
        .from('payroll_entries')
        .select('run_id, gross_pay, net_pay')
        .in('run_id', runIds);

      for (const e of (entries || [])) {
        if (!totalsMap[e.run_id]) totalsMap[e.run_id] = { employee_count: 0, total_gross: 0, total_net: 0 };
        totalsMap[e.run_id].employee_count += 1;
        totalsMap[e.run_id].total_gross   += Number(e.gross_pay || 0);
        totalsMap[e.run_id].total_net     += Number(e.net_pay   || 0);
      }
    }

    const enriched = (runs || []).map(r => ({ ...r, ...(totalsMap[r.id] || { employee_count: 0, total_gross: 0, total_net: 0 }) }));

    return NextResponse.json({ runs: enriched, total: count });
  } catch (err) {
    console.error('GET /api/payroll/runs unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const body = await request.json();
    const { period_type, period_start, period_end, run_type, notes } = body;

    if (!period_type || !['weekly', 'monthly'].includes(period_type)) {
      return NextResponse.json({ error: 'period_type must be weekly or monthly' }, { status: 400 });
    }
    if (!period_start || !period_end) {
      return NextResponse.json({ error: 'period_start and period_end are required' }, { status: 400 });
    }
    if (!run_type || !['casual', 'permanent', 'skilled_casual', 'combined'].includes(run_type)) {
      return NextResponse.json({ error: 'Invalid run_type' }, { status: 400 });
    }

    const runNum = await buildRunNum(run_type, period_start);
    if (!runNum) {
      return NextResponse.json({
        error: `A ${run_type} run already exists for week ${getISOWeek(period_start)} of ${new Date(period_start + 'T00:00:00Z').getUTCFullYear()} — only one run per type per week is allowed`,
      }, { status: 409 });
    }

    const { data: run, error: insertErr } = await serviceClient
      .from('payroll_runs')
      .insert({
        run_num:      runNum,
        period_type,
        period_start,
        period_end,
        run_type,
        notes:        notes || null,
        created_by:   user.id,
      })
      .select()
      .single();

    if (insertErr) {
      console.error('POST /api/payroll/runs insert error:', insertErr.message);
      return NextResponse.json({ error: 'Failed to create payroll run' }, { status: 500 });
    }

    await serviceClient.from('payroll_activities').insert({
      entity_type:   'run',
      entity_id:     run.id,
      activity_type: 'created',
      description:   `Payroll run ${run.run_num} (${run_type}) created by ${displayName}`,
      created_by:    user.id,
    });

    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    console.error('POST /api/payroll/runs unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
