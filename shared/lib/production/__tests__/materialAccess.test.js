import test from 'node:test';
import assert from 'node:assert/strict';
import { canSeeMaterialCost, materialSelect, materialEmbed, shapeMaterialRow, visibleMaterialRows, fetchJobMaterials, COST_FIELD_NAMES } from '../materialAccess.js';

const RESTRICTED = ['production_staff', 'head_of_sales', 'sales', 'viewer', undefined, null, ''];
const PRIVILEGED = ['admin', 'production_manager'];
const COST_TOKENS = ['estimated_unit_cost', 'estimated_total_cost', 'cost_source_type', 'preferred_supplier_id', 'suppliers'];

test('only admin and production_manager can see material cost', () => {
  for (const r of PRIVILEGED) assert.equal(canSeeMaterialCost(r), true);
  for (const r of RESTRICTED) assert.equal(canSeeMaterialCost(r), false, String(r));
});

test('restricted roles never SELECT a cost column (select string and embed)', () => {
  for (const r of RESTRICTED) {
    for (const s of [materialSelect(r), materialEmbed(r)]) for (const t of COST_TOKENS) assert.ok(!s.includes(t), `${r}: ${t}`);
  }
});
test('privileged roles do select the cost columns', () => {
  for (const r of PRIVILEGED) for (const t of COST_TOKENS) assert.ok(materialSelect(r).includes(t), t);
});
test('floor columns include quantity, spec, unit and notes', () => {
  const s = materialSelect('production_staff');
  for (const c of ['material_name', 'specification', 'unit', 'estimated_quantity', 'notes']) assert.ok(s.includes(c), c);
});

const fullRow = { id: 1, material_name: 'Oak', specification: '2x4', unit: 'pc', estimated_quantity: 4, notes: 'n', boq_line_type: 'material',
  estimated_unit_cost: 100, estimated_total_cost: 400, cost_source_type: 'supplier', preferred_supplier_id: 's', suppliers: { id: 's', name: 'Timber Co' }, preferred_supplier: { name: 'x' }, actual_unit_cost: 9 };

test('shapeMaterialRow strips every cost field even if the query over-selected', () => {
  for (const r of RESTRICTED) {
    const out = shapeMaterialRow(fullRow, r);
    for (const f of COST_FIELD_NAMES) assert.ok(!(f in out), `${r}: ${f}`);
    assert.equal(out.material_name, 'Oak');
  }
  assert.equal(shapeMaterialRow(fullRow, 'admin').estimated_unit_cost, 100);
});

test('floor roles do not see labour/machine costing lines; managers do', () => {
  const rows = [fullRow, { ...fullRow, id: 2, boq_line_type: 'internal_labour' }, { ...fullRow, id: 3, boq_line_type: 'machine_time' }];
  assert.deepEqual(visibleMaterialRows(rows, 'production_staff').map((r) => r.id), [1]);
  assert.equal(visibleMaterialRows(rows, 'production_manager').length, 3);
});

test('fetchJobMaterials: the query sent for a restricted role has no cost columns, and the response has none', async () => {
  let seen = null;
  const client = { from: () => ({ select: (s) => { seen = s; return { eq: () => ({ order: async () => ({ data: [fullRow], error: null }) }) }; } }) };
  const r = await fetchJobMaterials(client, 'j', 'production_staff');
  for (const t of COST_TOKENS) assert.ok(!seen.includes(t));
  assert.ok(!('estimated_unit_cost' in r.materials[0]) && !('suppliers' in r.materials[0]));
  const m = await fetchJobMaterials(client, 'j', 'admin');
  assert.ok(seen.includes('estimated_unit_cost'));
  assert.equal(m.materials[0].estimated_unit_cost, 100);
});
test('fetchJobMaterials surfaces a database error', async () => {
  const client = { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
  assert.equal((await fetchJobMaterials(client, 'j', 'admin')).error.message, 'boom');
});
