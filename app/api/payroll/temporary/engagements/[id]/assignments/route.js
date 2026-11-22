/**
 * GET /api/payroll/temporary/engagements/:id/assignments
 * Candidate Production assignments the worker could be linked to: same worker, same project, active.
 * Linking itself is the database function (admin / production manager only).
 */
import { NextResponse } from 'next/server';
import { guard, bad, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import { isUuid } from '@/shared/lib/payroll/temporaryAccess';

export async function GET(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const { data: eng, error: eErr } = await serviceClient.from('temporary_worker_engagements').select('id, employee_id, order_id').eq('id', id).maybeSingle();
  if (eErr) return dbError(eErr);
  if (!eng) return NextResponse.json({ error: 'Engagement not found' }, { status: 404 });
  const { data: jobs, error: jErr } = await serviceClient.from('production_jobs').select('id, job_num, description, status, planned_quantity').eq('order_id', eng.order_id);
  if (jErr) return dbError(jErr);
  const jobIds = (jobs || []).map(j => j.id);
  if (!jobIds.length) return NextResponse.json({ assignments: [], targets: [] });

  // Where the worker could be put: each open job with its enabled stages and the active operations of each stage.
  const { data: stages, error: sErr } = await serviceClient.from('production_job_stages')
    .select('id, job_id, stage_key, stage_label, sort_order').in('job_id', jobIds).eq('is_enabled', true).order('sort_order');
  if (sErr) return dbError(sErr);
  const { data: ops, error: oErr } = await serviceClient.from('production_operations')
    .select('id, code, name, stage_key').eq('is_active', true);
  if (oErr) return dbError(oErr);
  const targets = (jobs || []).filter(j => !['Cancelled', 'Completed'].includes(j.status)).map(j => ({
    job_id: j.id, job_num: j.job_num, description: j.description, planned_quantity: j.planned_quantity,
    stages: (stages || []).filter(s => s.job_id === j.id).map(s => ({
      stage_id: s.id, stage_label: s.stage_label,
      operations: (ops || []).filter(o => o.stage_key === s.stage_key).map(o => ({ id: o.id, name: o.name || o.code })),
    })).filter(s => s.operations.length),
  })).filter(j => j.stages.length);
  const { data: asg, error } = await serviceClient.from('production_job_assignments')
    .select('id, job_id, status, temporary_engagement_id')
    .eq('employee_id', eng.employee_id).in('job_id', jobIds).in('status', ['Assigned', 'In Progress']);
  if (error) return dbError(error);
  const jobById = Object.fromEntries((jobs || []).map(j => [j.id, j]));
  const rows = (asg || []).map(a => ({
    id: a.id, status: a.status, job_num: jobById[a.job_id]?.job_num || null, description: jobById[a.job_id]?.description || null,
    linked: a.temporary_engagement_id === id, linked_elsewhere: !!a.temporary_engagement_id && a.temporary_engagement_id !== id,
  }));
  return NextResponse.json({ assignments: rows, targets });
}
