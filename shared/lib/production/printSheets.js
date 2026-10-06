/**
 * shared/lib/production/printSheets.js
 *
 * Pure HTML builders for the three production print types. No I/O.
 *
 *   buildShopFloorCards  — for the workshop. NEVER shows money of any kind: the
 *                          input data simply does not contain it (the server
 *                          strips it) and these builders have no money fields.
 *   buildShortageSheet   — only jobs with material lines marked short; no prices.
 *   buildInternalPack    — managers only. Shows payroll-allocated labour cost and
 *                          estimated material cost, where a missing figure reads
 *                          "Not recorded" (never 0) and any total built from
 *                          incomplete data is flagged partial. Planned hours are
 *                          labelled "plan only" — the tracker captures no time.
 */

export const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const fmtDay = (iso) => (iso ? `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}` : '—');
const fmtKes = (n) => `KES ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const NOT_RECORDED = '<span class="nr">Not recorded</span>';

const CSS = `
  *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#181818;margin:0;padding:18px;font-size:12px}
  h1{font-size:16px;margin:0 0 2px} h2{font-size:14px;margin:0} h3{font-size:12px;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.04em;color:#555}
  .sheet{border:1px solid #bbb;border-radius:6px;padding:12px 14px;margin-bottom:14px;page-break-inside:avoid}
  .head{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #E8512A;padding-bottom:6px;margin-bottom:8px}
  .muted{color:#666} .pill{display:inline-block;border:1px solid #ccc;border-radius:10px;padding:1px 8px;margin:0 4px 2px 0;font-size:11px}
  table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #e5e5e5;vertical-align:top}
  th{font-size:10.5px;text-transform:uppercase;color:#666} td.num,th.num{text-align:right}
  .warn{background:#fff5d9;border:1px solid #ead69c;padding:5px 8px;border-radius:4px;margin:6px 0}
  .bad{background:#fde9e7;border:1px solid #efc8c4;padding:5px 8px;border-radius:4px;margin:6px 0}
  .nr{color:#96620a;font-style:italic} .foot{color:#888;font-size:10px;margin-top:10px}
  .line{display:inline-block;border-bottom:1px solid #888;width:260px}
  @media print{body{padding:0}}
`;

export function wrapDocument(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

const specPills = (j) =>
  [j.size, j.wood_type, j.finish_type, j.finish_color].filter(Boolean).map((v) => `<span class="pill">${escapeHtml(v)}</span>`).join('');

function stagesTable(j) {
  if (!j.stages?.length) return '<div class="muted">No stages scheduled.</div>';
  return `<table><thead><tr><th>Stage</th><th>Dates</th><th>Who</th><th>Status</th><th>Done</th></tr></thead><tbody>${
    j.stages.map((s) => `<tr><td>${escapeHtml(s.stage_label)}</td><td>${s.start ? `${fmtDay(s.start)} – ${fmtDay(s.end)}` : 'Not scheduled'}</td><td>${escapeHtml((s.workers || []).join(', ') || 'Unassigned')}</td><td>${escapeHtml((s.status || '').replace('_', ' '))}</td><td>________</td></tr>`).join('')
  }</tbody></table>`;
}

function materialsList(j) {
  if (!j.materials?.length) return '<div class="muted">No materials listed — see BoQ.</div>';
  return `<table><thead><tr><th>Material</th><th class="num">Qty</th><th>Unit</th><th>Ready?</th></tr></thead><tbody>${
    j.materials.map((m) => {
      const r = m.readiness === 'short' ? '<b style="color:#a8362d">SHORT</b>' : m.readiness === 'ready' ? 'Ready' : '☐';
      return `<tr><td>${escapeHtml(m.material_name)}${m.specification ? `<div class="muted">${escapeHtml(m.specification)}</div>` : ''}</td><td class="num">${escapeHtml(m.estimated_quantity ?? '')}</td><td>${escapeHtml(m.unit)}</td><td>${r}${m.readiness === 'short' && m.short_note ? `<div class="muted">${escapeHtml(m.short_note)}</div>` : ''}</td></tr>`;
    }).join('')
  }</tbody></table>`;
}

const IMG = /\.(png|jpe?g|gif|webp)(\?|$)/i;
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

// Drawings are printed by name, category and upload date. The tracker stores no
// revision number, so the upload date is shown as the version stamp.
function drawingsBlock(j) {
  const d = j.drawings || [];
  if (!d.length) return '<h3>Drawings</h3><div class="warn">No drawing is linked to this job.</div>';
  return `<h3>Drawings</h3>${d.map((x) => {
    const url = safeUrl(x.url);
    const img = url && (IMG.test(x.file_name || '') || IMG.test(url)) ? `<div><img src="${escapeHtml(url)}" alt="${escapeHtml(x.file_name)}" style="max-width:100%;max-height:260px;border:1px solid #ddd;margin:4px 0"></div>` : '';
    return `<div style="margin-bottom:6px"><b>${escapeHtml(x.file_name || 'Drawing')}</b>${x.category ? ` <span class="pill">${escapeHtml(x.category)}</span>` : ''}${x.uploaded_at ? ` <span class="muted">uploaded ${escapeHtml(x.uploaded_at)}</span>` : ''}${x.notes ? `<div class="muted">${escapeHtml(x.notes)}</div>` : ''}${img}</div>`;
  }).join('')}`;
}

function blockerBox(j) {
  if (!j.blockers?.length) return '';
  return j.blockers.map((b) =>
    `<div class="bad"><b>Blocked:</b> ${escapeHtml(b.reason)} · Owner: ${escapeHtml(b.owner_name || 'none')} · Expected: ${escapeHtml(b.expected_resolution_date ? fmtDay(b.expected_resolution_date) : 'no date')}${b.supplier_po_ref ? ` · Ref ${escapeHtml(b.supplier_po_ref)}` : ''}</div>`).join('');
}

function header(j, printedAt, label) {
  return `<div class="head"><div><h2>${escapeHtml(j.job_num)} · ${escapeHtml(j.name)}</h2><div class="muted">${escapeHtml(j.order_num || '')} · Qty ${escapeHtml(j.planned_quantity)}</div></div>
    <div style="text-align:right"><b>${escapeHtml(label)}</b><div class="muted">Production due: <b>${escapeHtml(fmtDay(j.production_due_date))}</b></div><div class="muted">Printed ${escapeHtml(printedAt)}</div></div></div>`;
}

export function buildShopFloorCards(jobs, { printedAt = '' } = {}) {
  const body = jobs.map((j) => `<div class="sheet">${header(j, printedAt, 'Shop-floor card')}
    <div>${specPills(j)}</div>
    ${blockerBox(j)}
    <h3>Stages</h3>${stagesTable(j)}
    <h3>Materials required</h3>${materialsList(j)}
    ${drawingsBlock(j)}
    ${j.production_instructions ? `<h3>Workshop notes</h3><div>${escapeHtml(j.production_instructions)}</div>` : ''}
    <h3>Notes / shortages</h3><div class="line"></div><div class="line" style="margin-top:10px"></div>
  </div>`).join('');
  return wrapDocument('Shop-floor cards', body || '<p>No jobs in this selection.</p>');
}

export function buildShortageSheet(jobs, { printedAt = '' } = {}) {
  const withShort = jobs.map((j) => ({ ...j, shorts: (j.materials || []).filter((m) => m.readiness === 'short') })).filter((j) => j.shorts.length);
  const body = `<h1>Shortage sheet</h1><div class="muted" style="margin-bottom:10px">Printed ${escapeHtml(printedAt)} · only lines marked short</div>${
    withShort.map((j) => `<div class="sheet">${header(j, printedAt, 'Shortage')}
      <table><thead><tr><th>Material</th><th class="num">Needed</th><th>Unit</th><th>Note</th></tr></thead><tbody>${
        j.shorts.map((m) => `<tr><td>${escapeHtml(m.material_name)}${m.specification ? `<div class="muted">${escapeHtml(m.specification)}</div>` : ''}</td><td class="num">${escapeHtml(m.estimated_quantity ?? '')}</td><td>${escapeHtml(m.unit)}</td><td>${escapeHtml(m.short_note || '')}</td></tr>`).join('')
      }</tbody></table>
      ${j.blockers?.length ? blockerBox(j) : '<div class="warn">No blocker raised yet — a shortage needs an owner and an expected date.</div>'}
    </div>`).join('') || '<p>No material shortages recorded.</p>'}`;
  return wrapDocument('Shortage sheet', body);
}

/**
 * @param {Array} packs  [{ ...job, finance: { materials:[{material_name, estimated_total_cost|null}],
 *                     labour:{ loaded:boolean, item_level:[{worker,amount,run_status}], order_level:[{worker,amount,run_status}] },
 *                     planned_hours:[{worker, stage_label, hours}] } }]
 */
export function buildInternalPack(packs, { printedAt = '' } = {}) {
  const body = packs.map((j) => {
    const f = j.finance || {};
    // Materials: estimate vs actual (issued qty x manager-entered unit cost)
    const mats = f.materials || [];
    const missingMat = mats.filter((m) => m.estimated_total_cost == null).length;
    const matTotal = mats.reduce((s, m) => s + (m.estimated_total_cost == null ? 0 : Number(m.estimated_total_cost)), 0);
    const actualRows = mats.filter((m) => m.actual_total_cost != null);
    const missingAct = mats.length - actualRows.length;
    const actTotal = actualRows.reduce((s, m) => s + Number(m.actual_total_cost), 0);
    const estOfActual = actualRows.reduce((s, m) => s + (m.estimated_total_cost == null ? 0 : Number(m.estimated_total_cost)), 0);
    const cell = (v) => (v == null ? NOT_RECORDED : escapeHtml(fmtKes(v)));
    const varCell = (m) => {
      if (m.actual_total_cost == null || m.estimated_total_cost == null) return NOT_RECORDED;
      const d = Number(m.actual_total_cost) - Number(m.estimated_total_cost);
      return `<span style="color:${d > 0 ? '#a8362d' : '#16794a'}">${d > 0 ? '+' : d < 0 ? '−' : ''}${escapeHtml(fmtKes(Math.abs(d)))}</span>`;
    };
    const qtyCell = (m) => (m.issued_quantity == null ? NOT_RECORDED : `${escapeHtml(m.issued_quantity)} ${escapeHtml(m.unit || '')}`);
    const matRows = mats.map((m) => `<tr><td>${escapeHtml(m.material_name)}</td><td class="num">${m.estimated_quantity == null ? NOT_RECORDED : `${escapeHtml(m.estimated_quantity)} ${escapeHtml(m.unit || '')}`}</td><td class="num">${qtyCell(m)}</td><td class="num">${cell(m.estimated_total_cost)}</td><td class="num">${cell(m.actual_total_cost)}</td><td class="num">${varCell(m)}</td></tr>`).join('');
    const matTotalCell = !mats.length ? NOT_RECORDED
      : `${escapeHtml(fmtKes(matTotal))}${missingMat ? ` <span class="nr">(partial — ${missingMat} line(s) not recorded)</span>` : ''}`;
    const actTotalCell = !actualRows.length ? NOT_RECORDED
      : `${escapeHtml(fmtKes(actTotal))}${missingAct ? ` <span class="nr">(partial — ${missingAct} line(s) not recorded)</span>` : ''}`;
    const actNote = f.actuals_loaded === false ? `<div class="warn">Actual usage could not be loaded (run production_v2f) — shown as ${NOT_RECORDED}.</div>` : '';

    // Labour (payroll-allocated, not time-captured)
    const lab = f.labour || {};
    const pend = (r) => (r.run_status === 'approved' || r.run_status === 'closed' ? '' : ' <span class="nr">(pending — payroll run not approved)</span>');
    const labRow = (r, tag) => `<tr><td>${escapeHtml(r.worker)} <span class="muted">${tag}</span></td><td class="num">${escapeHtml(fmtKes(r.amount))}${pend(r)}</td></tr>`;
    let labourHtml;
    if (lab.loaded === false) labourHtml = `<div class="warn">Labour cost could not be loaded — treat as ${NOT_RECORDED}.</div>`;
    else if (!(lab.item_level?.length || lab.order_level?.length)) labourHtml = `<div>${NOT_RECORDED} <span class="muted">— no payroll allocation yet</span></div>`;
    else {
      const itemTotal = (lab.item_level || []).reduce((s, r) => s + Number(r.amount), 0);
      const hasPending = [...(lab.item_level || []), ...(lab.order_level || [])].some((r) => !(r.run_status === 'approved' || r.run_status === 'closed'));
      labourHtml = `<table><tbody>${(lab.item_level || []).map((r) => labRow(r, 'allocated to this item')).join('')}${(lab.order_level || []).map((r) => labRow(r, 'order-level — not split by job')).join('')}</tbody></table>
        ${(lab.item_level || []).length ? `<div>Item-level total: <b>${escapeHtml(fmtKes(itemTotal))}</b>${hasPending ? ' <span class="nr">(partial — includes pending runs)</span>' : ''}</div>` : '<div class="muted">No allocation is tied to this job; order-level amounts are not split by job and are not totalled here.</div>'}`;
    }

    // Planned hours (plan only)
    const hrs = f.planned_hours || [];
    const hoursHtml = hrs.length
      ? `<table><thead><tr><th>Worker</th><th>Stage</th><th class="num">Planned h</th></tr></thead><tbody>${hrs.map((h) => `<tr><td>${escapeHtml(h.worker)}</td><td>${escapeHtml(h.stage_label)}</td><td class="num">${escapeHtml(h.hours)}</td></tr>`).join('')}</tbody></table>`
      : `<div>${NOT_RECORDED}</div>`;

    return `<div class="sheet">${header(j, printedAt, 'Internal pack — confidential')}
      <div>${specPills(j)}</div>${blockerBox(j)}
      <h3>Stages</h3>${stagesTable(j)}
      <h3>Materials — estimate vs actual</h3>${actNote}${mats.length
        ? `<table><thead><tr><th>Material</th><th class="num">Est. qty</th><th class="num">Issued</th><th class="num">Est. cost</th><th class="num">Actual cost</th><th class="num">Variance</th></tr></thead><tbody>${matRows}<tr><th>Total</th><th></th><th></th><th class="num">${matTotalCell}</th><th class="num">${actTotalCell}</th><th class="num">${actualRows.length && !missingAct && !missingMat ? escapeHtml(fmtKes(actTotal - estOfActual)) : NOT_RECORDED}</th></tr></tbody></table>`
        : NOT_RECORDED}
      <h3>Labour — payroll-allocated cost</h3>${labourHtml}
      <h3>Planned hours <span class="muted" style="text-transform:none">(plan only — actual time is not captured)</span></h3>${hoursHtml}
    </div>`;
  }).join('');
  return wrapDocument('Internal pack', body || '<p>No jobs in this selection.</p>');
}
