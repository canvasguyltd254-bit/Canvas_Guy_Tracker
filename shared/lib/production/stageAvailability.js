/**
 * shared/lib/production/stageAvailability.js
 *
 * How many units are ready to be worked at each stage right now.
 *   available = upstream completed − this stage's completed
 *   first stage: upstream = the job's planned quantity
 *   packaging:   upstream = the job's accepted_qty (units that passed QC)
 * Clamped at 0 — completed_quantity can exceed planned when rework units pass
 * a stage a second time. QC is a gate with no stage row, so it is not listed.
 * Pure; reads persisted numbers only and never writes anything.
 */

/**
 * @param {{planned_quantity:number, accepted_qty?:number, stages:Array<{id,stage_key,sort_order,status,completed_quantity,planned_quantity}>}} job
 * @returns {Array<{stage_id,stage_key,available:number,completed:number,upstream:number}>}
 */
export function stageAvailability(job) {
  const stages = [...(job.stages || [])]
    .filter((s) => s.is_enabled !== false && s.status !== 'skipped')
    .sort((a, b) => a.sort_order - b.sort_order);
  let prevCompleted = null;
  return stages.map((s) => {
    let upstream;
    if (s.stage_key === 'packaging') upstream = Number(job.accepted_qty || 0);
    else if (prevCompleted === null) upstream = Number(job.planned_quantity || 0);
    else upstream = prevCompleted;
    const completed = Number(s.completed_quantity || 0);
    prevCompleted = completed;
    return {
      stage_id: s.id, stage_key: s.stage_key, upstream, completed,
      available: s.status === 'completed' ? 0 : Math.max(0, upstream - completed),
    };
  });
}
