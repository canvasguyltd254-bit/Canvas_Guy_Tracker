import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageAvailability } from '../stageAvailability.js';

const job = () => ({
  planned_quantity: 10, accepted_qty: 3,
  stages: [
    { id: 'm', stage_key: 'materials', sort_order: 1, status: 'completed', completed_quantity: 10 },
    { id: 'a', stage_key: 'assembly',  sort_order: 2, status: 'active', completed_quantity: 6 },
    { id: 's', stage_key: 'sanding',   sort_order: 3, status: 'active', completed_quantity: 2 },
    { id: 'f', stage_key: 'finishing', sort_order: 4, status: 'not_started', completed_quantity: 0 },
    { id: 'p', stage_key: 'packaging', sort_order: 5, status: 'not_started', completed_quantity: 1 },
  ],
});
const by = (r) => Object.fromEntries(r.map((x) => [x.stage_key, x.available]));

test('available = upstream completed − this completed; first stage uses planned qty', () => {
  assert.deepEqual(by(stageAvailability(job())), { materials: 0, assembly: 4, sanding: 4, finishing: 2, packaging: 2 });
});
test('packaging comes from accepted_qty, not from finishing', () => {
  const j = job(); j.accepted_qty = 0; j.stages[3].completed_quantity = 8;
  assert.equal(by(stageAvailability(j)).packaging, 0);
});
test('disabled/skipped stages are skipped and rework over-completion clamps to 0', () => {
  const j = job(); j.stages[2].status = 'skipped'; j.stages[1].completed_quantity = 12;
  const r = by(stageAvailability(j));
  assert.equal(r.sanding, undefined);
  assert.equal(r.assembly, 0);
  assert.equal(r.finishing, 12); // upstream becomes assembly's completed (sanding skipped)
});
