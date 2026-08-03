export const runtime = 'nodejs';

/**
 * GET /api/crm/insights
 * Live pipeline stats for the Insights tab.
 * Returns: stage counts, source distribution, pipeline value, category demand, conversion rate.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    const [enqRes, qtRes, followupRes] = await Promise.all([
      serviceClient.from('enquiries').select('id, stage, source, category, estimated_value'),
      serviceClient.from('quotations').select('id, status, total, tax_status, created_at'),
      serviceClient.from('followups').select('id, due_date, completed_at'),
    ]);

    const enquiries = enqRes.data || [];
    const quotations = qtRes.data || [];
    const followups = followupRes.data || [];

    // Stage funnel
    const stageCounts = {};
    for (const e of enquiries) {
      stageCounts[e.stage] = (stageCounts[e.stage] || 0) + 1;
    }

    // Source breakdown
    const sourceMap = {};
    for (const e of enquiries) {
      const src = e.source || 'unknown';
      if (!sourceMap[src]) sourceMap[src] = { count: 0, value: 0 };
      sourceMap[src].count += 1;
      sourceMap[src].value += parseFloat(e.estimated_value || 0);
    }

    // Category demand
    const categoryMap = {};
    for (const e of enquiries) {
      const cat = e.category || 'Other';
      categoryMap[cat] = (categoryMap[cat] || 0) + 1;
    }

    // Quote funnel
    const quoteFunnel = { draft: 0, sent: 0, accepted: 0, rejected: 0, expired: 0, superseded: 0 };
    let pipelineValue = 0;
    let acceptedValue = 0;
    for (const q of quotations) {
      quoteFunnel[q.status] = (quoteFunnel[q.status] || 0) + 1;
      if (!['rejected', 'expired', 'superseded', 'accepted', 'converted'].includes(q.status)) {
        pipelineValue += parseFloat(q.total || 0);
      }
      if (q.status === 'accepted') acceptedValue += parseFloat(q.total || 0);
    }

    const totalQuotes  = quotations.filter(q => q.status !== 'superseded').length;
    const conversionRate = totalQuotes > 0
      ? Math.round((quoteFunnel.accepted / totalQuotes) * 100)
      : 0;

    // Follow-up stats
    const now = new Date();
    const pendingFollowups  = followups.filter(f => !f.completed_at).length;
    const overdueFollowups  = followups.filter(f => !f.completed_at && new Date(f.due_date) < now).length;

    return NextResponse.json({
      data: {
        stageCounts,
        sourceBreakdown: sourceMap,
        categoryDemand: categoryMap,
        quoteFunnel,
        pipelineValue: Math.round(pipelineValue),
        acceptedValue: Math.round(acceptedValue),
        conversionRate,
        totalEnquiries: enquiries.length,
        totalQuotations: totalQuotes,
        followups: { pending: pendingFollowups, overdue: overdueFollowups },
      },
    });
  } catch (err) {
    console.error('GET /api/crm/insights:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
