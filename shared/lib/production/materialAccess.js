/**
 * shared/lib/production/materialAccess.js — who may see material COST data.
 *
 * Cost columns are never selected for roles that may not see them (we do not fetch everything and
 * delete fields afterwards). Floor roles receive quantities, spec, units, readiness and notes only.
 * `shapeMaterialRow` is a second, whitelist-based layer: even if a caller selects too much, an
 * unprivileged role still cannot get a cost field out of it.
 */

export const MATERIAL_COST_ROLES = ['admin', 'production_manager'];
export const canSeeMaterialCost = (role) => MATERIAL_COST_ROLES.includes(role);

// Lines that are costing artefacts (not things a worker gathers or issues).
export const FLOOR_HIDDEN_LINE_TYPES = ['internal_labour', 'machine_time'];

const FLOOR_COLUMNS = [
  'id', 'material_name', 'specification', 'unit',
  'quantity_per_unit', 'planned_quantity', 'waste_percentage', 'estimated_quantity', 'adjustment_quantity',
  'boq_line_type', 'notes', 'created_at', 'updated_at',
];
const COST_COLUMNS = ['estimated_unit_cost', 'estimated_total_cost', 'cost_source_type', 'preferred_supplier_id', 'suppliers(id, name)'];
export const COST_FIELD_NAMES = ['estimated_unit_cost', 'estimated_total_cost', 'cost_source_type', 'preferred_supplier_id', 'suppliers', 'preferred_supplier', 'actual_unit_cost', 'issued_quantity_cost'];

/** Column list for production_material_estimates, chosen by role. */
export function materialSelect(role, { extra = [] } = {}) {
  return [...FLOOR_COLUMNS, ...extra, ...(canSeeMaterialCost(role) ? COST_COLUMNS : [])].join(', ');
}

/** PostgREST embed for nested use: production_material_estimates(...) */
export function materialEmbed(role) {
  return `production_material_estimates(${materialSelect(role)})`;
}

/** Whitelist-shape one row for a role. */
export function shapeMaterialRow(row, role) {
  if (canSeeMaterialCost(role)) return row;
  const out = {};
  for (const k of FLOOR_COLUMNS) if (k in row) out[k] = row[k];
  return out;
}

/** Rows a given role may see (floor roles do not see labour/machine costing lines). */
export function visibleMaterialRows(rows, role) {
  const list = rows || [];
  if (canSeeMaterialCost(role)) return list;
  return list.filter((m) => !FLOOR_HIDDEN_LINE_TYPES.includes(m.boq_line_type)).map((m) => shapeMaterialRow(m, role));
}

/** Fetch a job's material lines. `client` is a Supabase client (injected so this is unit-testable). */
export async function fetchJobMaterials(client, jobId, role) {
  const { data, error } = await client
    .from('production_material_estimates')
    .select(materialSelect(role))
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  if (error) return { error };
  return { materials: visibleMaterialRows(data, role) };
}
