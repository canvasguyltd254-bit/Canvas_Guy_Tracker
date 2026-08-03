/**
 * scripts/build_report.js
 * Pure Node.js replacement for build_report.py
 * Uses pdfkit (no Python required — works on Vercel)
 *
 * Exports: buildReportPDF(data) → Promise<Buffer>
 *
 * Accepts the same JSON shape as the Python script.
 */

'use strict';

// pdfkit runs only in the child process spawned by the API routes —
// webpack never sees this file, so no bundling config is needed.
const PDFDocument = require('pdfkit');
const nodePath    = require('path');
const nodeFs      = require('fs');

// Logo embedded in delivery note PDFs — same position in both copy variants.
const LOGO_PATH = nodePath.join(__dirname, '..', 'public', 'canvas-guy-logo.png');
const HAS_LOGO  = nodeFs.existsSync(LOGO_PATH);

// ── Unit conversion ────────────────────────────────────────────────────────────
const MM = 2.8346; // 1 mm in points

// ── Brand colours ──────────────────────────────────────────────────────────────
const CORAL = '#E8512A';
const WHITE = '#FFFFFF';
const LGRAY = '#F5F5F5';
const MGRAY = '#CCCCCC';
const DGRAY = '#444444';
const DKROW = '#2A2A2A';

// ── Landscape A4 ──────────────────────────────────────────────────────────────
const LW      = 841.89;
const LH      = 595.28;
const LM      = 12 * MM;
const LCW     = LW - 2 * LM;
const LBOTTOM = 18 * MM;
const ROW_H   = 6.5 * MM;
const HDR_H   = 7   * MM;

// ── Portrait A4 ───────────────────────────────────────────────────────────────
const PW      = 595.28;
const PH      = 841.89;
const PM      = 12 * MM;
const PCW     = PW - 2 * PM;
const PBOTTOM = 18 * MM;

// ── Formatters ─────────────────────────────────────────────────────────────────
function fmtKes(n) {
  const num = Math.round(parseFloat(n || 0));
  return num.toLocaleString('en-KE');
}

function fmtDate(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s).slice(0, 10);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return String(s).slice(0, 10);
  }
}

// ── Drawing helpers ────────────────────────────────────────────────────────────

function fillRect(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color).restore();
}

/** Draw text at (x, y) — y is the TOP of the text line. */
function drawLeft(doc, text, x, y, { font = 'Helvetica', size = 6.5, color = DGRAY, maxW } = {}) {
  doc.font(font).fontSize(size);
  let str = String(text ?? '—');
  if (maxW) {
    while (str.length > 1 && doc.widthOfString(str) > maxW - 3 * MM) {
      str = str.slice(0, -2) + '…';
    }
  }
  doc.fillColor(color).text(str, x + 1.5 * MM, y, { lineBreak: false });
}

function drawRight(doc, text, rightX, y, { font = 'Helvetica', size = 6.5, color = DGRAY, maxW } = {}) {
  doc.font(font).fontSize(size);
  let str = String(text ?? '—');
  if (maxW) {
    while (str.length > 1 && doc.widthOfString(str) > maxW - 3 * MM) {
      str = str.slice(0, -2) + '…';
    }
  }
  const w = doc.widthOfString(str);
  doc.fillColor(color).text(str, rightX - w - 1.5 * MM, y, { lineBreak: false });
}

function drawCenter(doc, text, centerX, y, { font = 'Helvetica', size = 6.5, color = DGRAY } = {}) {
  doc.font(font).fontSize(size);
  const str = String(text ?? '');
  const w   = doc.widthOfString(str);
  doc.fillColor(color).text(str, centerX - w / 2, y, { lineBreak: false });
}

// ── Landscape column definitions (x + w in mm, converted below) ───────────────

function mmCols(defs) {
  return defs.map(d => ({ ...d, x: d.x * MM, w: d.w * MM }));
}

const PROD_COLS = mmCols([
  { key: 'client',      header: 'Client',      x:   0, w: 40, bold: true },
  { key: 'order_num',   header: 'Order #',     x:  40, w: 22, size: 6 },
  { key: 'due_date',    header: 'Due',         x:  62, w: 20 },
  { key: 'status',      header: 'Status',      x:  82, w: 28 },
  { key: 'category',    header: 'Category',    x: 110, w: 23 },
  { key: 'description', header: 'Description', x: 133, w: 52 },
  { key: 'qty',         header: 'Qty',         x: 185, w: 11, centre: true, bold: true },
  { key: 'size',        header: 'Size',        x: 196, w: 27 },
  { key: 'finish',      header: 'Finish',      x: 223, w: 27 },
  { key: 'wood',        header: 'Wood',        x: 250, w: 23 },
]);

const FIN_COLS = mmCols([
  { key: 'client',    header: 'Client',        x:   0, w: 55, bold: true },
  { key: 'order_num', header: 'Order #',       x:  55, w: 22, size: 6 },
  { key: 'due_date',  header: 'Due Date',      x:  77, w: 22 },
  { key: 'status',    header: 'Status',        x:  99, w: 38 },
  { key: 'value',     header: 'Value (KES)',   x: 137, w: 40, right: true },
  { key: 'paid',      header: 'Paid (KES)',    x: 177, w: 40, right: true },
  { key: 'balance',   header: 'Balance (KES)', x: 217, w: 56, right: true, bold: true },
]);

const SUPPLIER_COLS = mmCols([
  { key: 'supplier_name', header: 'Supplier',      x:   0, w: 50, bold: true },
  { key: 'purchase_date', header: 'Date',          x:  50, w: 22 },
  { key: 'items_bought',  header: 'Items',         x:  72, w: 78 },
  { key: 'total',         header: 'Total (KES)',   x: 150, w: 35, right: true },
  { key: 'paid',          header: 'Paid (KES)',    x: 185, w: 35, right: true },
  { key: 'balance',       header: 'Balance (KES)', x: 220, w: 35, right: true, bold: true },
  { key: 'status',        header: 'Status',        x: 255, w: 18 },
]);

const ORDER_PNL_COLS = mmCols([
  { key: 'order_num',  header: 'Order #',        x:   0, w: 22, size: 6 },
  { key: 'client',     header: 'Client',          x:  22, w: 45, bold: true },
  { key: 'status',     header: 'Status',          x:  67, w: 32 },
  { key: 'revenue',    header: 'Revenue (KES)',   x:  99, w: 38, right: true },
  { key: 'collected',  header: 'Collected (KES)', x: 137, w: 35, right: true },
  { key: 'costs',      header: 'Material Costs',  x: 172, w: 38, right: true },
  { key: 'profit',     header: 'Gross Profit',    x: 210, w: 38, right: true, bold: true },
  { key: 'margin',     header: 'Margin %',        x: 248, w: 25, right: true },
]);

const CUSTOMER_REC_COLS = mmCols([
  { key: 'name',         header: 'Customer',          x:   0, w: 55, bold: true },
  { key: 'terms',        header: 'Terms',             x:  55, w: 20 },
  { key: 'total_sales',  header: 'Total Sales (KES)', x:  75, w: 40, right: true },
  { key: 'outstanding',  header: 'Outstanding (KES)', x: 115, w: 40, right: true, bold: true },
  { key: 'overdue',      header: 'Overdue (KES)',     x: 155, w: 38, right: true },
  { key: 'credit_limit', header: 'Credit Limit',      x: 193, w: 38, right: true },
  { key: 'avail',        header: 'Avail. Credit',     x: 231, w: 27, right: true },
  { key: 'orders',       header: 'Orders',            x: 258, w: 15, centre: true },
]);

const CUSTOMER_ORDER_COLS = mmCols([
  { key: 'customer_name', header: 'Customer',      x:   0, w: 50, bold: true },
  { key: 'order_num',     header: 'Order #',       x:  50, w: 22, size: 6 },
  { key: 'date',          header: 'Date',          x:  72, w: 22 },
  { key: 'due_date',      header: 'Due Date',      x:  94, w: 22 },
  { key: 'status',        header: 'Status',        x: 116, w: 38 },
  { key: 'value',         header: 'Value (KES)',   x: 154, w: 37, right: true },
  { key: 'paid',          header: 'Paid (KES)',    x: 191, w: 37, right: true },
  { key: 'balance',       header: 'Balance (KES)', x: 228, w: 45, right: true, bold: true },
]);

// Portrait statement columns (x + w in mm)
const STMT_COLS = mmCols([
  { key: 'date',        header: 'Date',          x:   0, w: 25 },
  { key: 'type',        header: 'Type',          x:  25, w: 28 },
  { key: 'description', header: 'Description',   x:  53, w: 65 },
  { key: 'debit',       header: 'Debit (KES)',   x: 118, w: 23, right: true },
  { key: 'credit',      header: 'Credit (KES)',  x: 141, w: 23, right: true },
  { key: 'balance',     header: 'Balance (KES)', x: 164, w: 22, right: true, bold: true },
]);

// ── Page-level drawing ────────────────────────────────────────────────────────

/**
 * Draw landscape page header. Returns y where content begins.
 */
function drawLandscapeHeader(doc, label, subtitle, nowStr, user, pageNum) {
  // Coral top band (13mm tall)
  fillRect(doc, 0, 0, LW, 13 * MM, CORAL);
  drawLeft(doc, 'CANVAS GUY LIMITED', LM, 4 * MM,
    { font: 'Helvetica-Bold', size: 10, color: WHITE });
  drawRight(doc, 'Ruiru - Gwa Kairo Thome Rd  |  Kiambu County, Kenya  |  holla@canvasguy.co.ke  |  0713 196 650',
    LW - LM, 5.5 * MM, { size: 6.5, color: WHITE });

  let y = 16 * MM;
  drawLeft(doc, label.toUpperCase(), LM, y, { font: 'Helvetica-Bold', size: 11, color: DGRAY });
  drawRight(doc, `${nowStr}   |   Page ${pageNum}`, LW - LM, y, { size: 7, color: DGRAY });

  y += 5 * MM;
  if (subtitle) drawLeft(doc, subtitle, LM, y, { size: 7, color: DGRAY });
  if (user) drawRight(doc, `By: ${user}`, LW - LM, y, { size: 7, color: DGRAY });

  y += 4 * MM;
  doc.save().moveTo(LM, y).lineTo(LW - LM, y).lineWidth(0.4).stroke(MGRAY).restore();
  y += 3 * MM;
  return y;
}

/**
 * Draw portrait page header for supplier statement. Returns y where content begins.
 */
function drawPortraitSupplierHeader(doc, subtitle, nowStr, user, pageNum, first, supplier) {
  fillRect(doc, 0, 0, PW, 13 * MM, CORAL);
  drawLeft(doc, 'CANVAS GUY LIMITED', PM, 4 * MM,
    { font: 'Helvetica-Bold', size: 10, color: WHITE });
  drawRight(doc, 'Ruiru - Gwa Kairo Thome Rd  |  Kiambu County, Kenya  |  holla@canvasguy.co.ke  |  0713 196 650',
    PW - PM, 5.5 * MM, { size: 6.5, color: WHITE });

  let y = 16 * MM;
  drawLeft(doc, 'SUPPLIER STATEMENT', PM, y, { font: 'Helvetica-Bold', size: 11, color: DGRAY });
  drawRight(doc, `${nowStr}   |   Page ${pageNum}`, PW - PM, y, { size: 7, color: DGRAY });

  y += 5 * MM;
  if (subtitle) drawLeft(doc, subtitle, PM, y, { size: 7, color: DGRAY });

  y += 4 * MM;
  doc.save().moveTo(PM, y).lineTo(PW - PM, y).lineWidth(0.4).stroke(MGRAY).restore();
  y += 3 * MM;

  if (first && supplier) {
    const boxH = 22 * MM;
    fillRect(doc, PM, y, PCW, boxH, LGRAY);
    drawLeft(doc, (supplier.name || '').toUpperCase(), PM, y + 2 * MM,
      { font: 'Helvetica-Bold', size: 8, color: DGRAY });

    const infoLines = [
      supplier.address,
      [supplier.phone, supplier.email].filter(Boolean).join('  ·  '),
      supplier.contact_person ? `Contact: ${supplier.contact_person}` : null,
      user ? `Prepared by: ${user}` : null,
    ].filter(Boolean);

    infoLines.forEach((line, i) => {
      drawLeft(doc, line, PM, y + 8 * MM + i * 3.5 * MM, { size: 6.5, color: DGRAY });
    });
    y += boxH + 4 * MM;
  }

  return y + 2 * MM;
}

/**
 * Draw portrait page header. Returns y where content begins.
 * If first=true, also draws the customer info box.
 */
function drawPortraitHeader(doc, subtitle, nowStr, user, pageNum, first, cust) {
  // Coral top band
  fillRect(doc, 0, 0, PW, 13 * MM, CORAL);
  drawLeft(doc, 'CANVAS GUY LIMITED', PM, 4 * MM,
    { font: 'Helvetica-Bold', size: 10, color: WHITE });
  drawRight(doc, 'Ruiru - Gwa Kairo Thome Rd  |  Kiambu County, Kenya  |  holla@canvasguy.co.ke  |  0713 196 650',
    PW - PM, 5.5 * MM, { size: 6.5, color: WHITE });

  let y = 16 * MM;
  drawLeft(doc, 'CUSTOMER STATEMENT', PM, y, { font: 'Helvetica-Bold', size: 11, color: DGRAY });
  drawRight(doc, `${nowStr}   |   Page ${pageNum}`, PW - PM, y, { size: 7, color: DGRAY });

  y += 5 * MM;
  if (subtitle) drawLeft(doc, subtitle, PM, y, { size: 7, color: DGRAY });

  y += 4 * MM;
  doc.save().moveTo(PM, y).lineTo(PW - PM, y).lineWidth(0.4).stroke(MGRAY).restore();
  y += 3 * MM;

  if (first && cust) {
    const boxH = 22 * MM;
    fillRect(doc, PM, y, PCW, boxH, LGRAY);
    drawLeft(doc, (cust.name || '').toUpperCase(), PM, y + 2 * MM,
      { font: 'Helvetica-Bold', size: 8, color: DGRAY });

    const infoLines = [
      cust.address,
      [cust.phone, cust.email].filter(Boolean).join('  ·  '),
      cust.credit_terms ? `Terms: ${cust.credit_terms}` : null,
      user ? `Prepared by: ${user}` : null,
    ].filter(Boolean);

    infoLines.forEach((line, i) => {
      drawLeft(doc, line, PM, y + 8 * MM + i * 3.5 * MM, { size: 6.5, color: DGRAY });
    });
    y += boxH + 4 * MM;
  }

  return y + 2 * MM;
}

function drawWorkloadCards(doc, y, items) {
  if (!items || !items.length) return y;

  // Black spec bar
  fillRect(doc, LM, y, LCW, 8 * MM, '#000000');
  drawLeft(doc, 'WORKLOAD BY CATEGORY', LM, y + 1.5 * MM,
    { font: 'Helvetica-Bold', size: 7.5, color: CORAL });
  y += 8 * MM + 3 * MM;

  const n      = items.length;
  const cardW  = Math.min(38 * MM, (LCW - (n - 1) * 3 * MM) / n);
  const cardH  = 14 * MM;
  let   cx     = LM;

  items.forEach(cat => {
    doc.save().rect(cx, y, cardW, cardH).fillAndStroke(LGRAY, MGRAY).restore();
    drawCenter(doc, String(cat.qty ?? 0), cx + cardW / 2, y + 2 * MM,
      { font: 'Helvetica-Bold', size: 13, color: CORAL });
    drawCenter(doc, String(cat.label ?? ''), cx + cardW / 2, y + 9 * MM,
      { size: 5.5, color: DGRAY });
    cx += cardW + 3 * MM;
  });

  return y + cardH + 5 * MM;
}

function drawSectionBar(doc, y, text, cw = LCW, margin = LM) {
  fillRect(doc, margin, y, cw, 7 * MM, '#000000');
  drawLeft(doc, text, margin, y + 1.5 * MM,
    { font: 'Helvetica-Bold', size: 7.5, color: WHITE });
  return y + 7 * MM;
}

function drawColHeaders(doc, y, cols, margin = LM) {
  fillRect(doc, margin, y, cols.reduce((s, c) => Math.max(s, c.x + c.w), 0), HDR_H, DKROW);
  cols.forEach(col => {
    const x = margin + col.x;
    const opts = { font: 'Helvetica-Bold', size: 6.5, color: WHITE, maxW: col.w };
    if (col.right)   drawRight(doc, col.header, x + col.w, y + 1.5 * MM, opts);
    else if (col.centre) drawCenter(doc, col.header, x + col.w / 2, y + 1.5 * MM, opts);
    else             drawLeft(doc, col.header, x, y + 1.5 * MM, opts);
  });
  return y + HDR_H;
}

function drawDataRow(doc, y, cols, values, rowIdx, margin = LM) {
  const totalW = cols.reduce((s, c) => Math.max(s, c.x + c.w), 0);
  fillRect(doc, margin, y, totalW, ROW_H, rowIdx % 2 === 0 ? LGRAY : WHITE);
  doc.save().moveTo(margin, y + ROW_H).lineTo(margin + totalW, y + ROW_H).lineWidth(0.2).stroke(MGRAY).restore();

  cols.forEach(col => {
    const raw  = values[col.key];
    const text = (raw === null || raw === undefined || raw === '') ? '—' : String(raw);
    const font  = col.bold ? 'Helvetica-Bold' : 'Helvetica';
    const size  = col.size || 6.5;
    const x     = margin + col.x;
    const opts  = { font, size, color: DGRAY, maxW: col.w };

    if (col.right)   drawRight(doc, text, x + col.w, y + 1.5 * MM, opts);
    else if (col.centre) drawCenter(doc, text, x + col.w / 2, y + 1.5 * MM, opts);
    else             drawLeft(doc, text, x, y + 1.5 * MM, opts);
  });

  return y + ROW_H;
}

function drawTotalsBar(doc, y, leftText, rightText, cw = LCW, margin = LM) {
  fillRect(doc, margin, y, cw, 8 * MM, CORAL);
  drawLeft(doc, leftText, margin, y + 1.5 * MM,
    { font: 'Helvetica-Bold', size: 7.5, color: WHITE });
  if (rightText) {
    drawRight(doc, rightText, margin + cw, y + 1.5 * MM,
      { font: 'Helvetica-Bold', size: 7.5, color: WHITE });
  }
  return y + 8 * MM;
}

// ── Main export ───────────────────────────────────────────────────────────────

function buildReportPDF(data) {
  return new Promise((resolve, reject) => {
    try {
      const reportLabel = data.reportLabel || 'Report';
      const dateFrom    = data.dateFrom;
      const dateTo      = data.dateTo;
      const userName    = data.userName || '';

      const subtitleParts = [];
      if (dateFrom && dateTo) subtitleParts.push(`${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`);
      const subtitle = subtitleParts.join('  ·  ') || null;

      const now    = new Date();
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const nowStr = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}, ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

      const chunks = [];
      let   doc;

      // ── Supplier purchases ────────────────────────────────────────────────
      const supplierPurchases = data.supplierPurchases;
      if (supplierPurchases != null) {
        doc = new PDFDocument({ size: [LW, LH], autoFirstPage: false, margin: 0 });
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const cols = SUPPLIER_COLS;
        const rows = supplierPurchases.map(p => {
          const t   = parseFloat(p.total_amount || 0);
          const pd  = parseFloat(p.amount_paid  || 0);
          const bal = Math.max(t - pd, 0);
          const supName = (typeof p.suppliers === 'object' && p.suppliers)
            ? (p.suppliers.name || p.supplier_name || '—')
            : (p.supplier_name || '—');
          return {
            supplier_name: supName,
            purchase_date: fmtDate(p.purchase_date),
            items_bought:  p.items_bought || '—',
            total:         fmtKes(t),
            paid:          fmtKes(pd),
            balance:       fmtKes(bal),
            status:        p.payment_status || '',
          };
        });

        let pageNum = 1;
        doc.addPage();
        let y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum);
        y = drawSectionBar(doc, y, 'SUPPLIER PURCHASES');
        y = drawColHeaders(doc, y, cols);

        rows.forEach((row, idx) => {
          if (y + ROW_H > LH - LBOTTOM) {
            doc.addPage();
            pageNum++;
            y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum);
            y = drawSectionBar(doc, y, 'SUPPLIER PURCHASES (continued)');
            y = drawColHeaders(doc, y, cols);
          }
          y = drawDataRow(doc, y, cols, row, idx);
        });

        if (y + 10 * MM > LH - LBOTTOM) { doc.addPage(); pageNum++; y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum); }
        const n = supplierPurchases.length;
        const tv = supplierPurchases.reduce((s, p) => s + parseFloat(p.total_amount || 0), 0);
        const tp = supplierPurchases.reduce((s, p) => s + parseFloat(p.amount_paid  || 0), 0);
        drawTotalsBar(doc, y + 2 * MM,
          `TOTAL  |  ${n} purchase${n !== 1 ? 's' : ''}`,
          `Total: KES ${fmtKes(tv)}   Paid: KES ${fmtKes(tp)}   Outstanding: KES ${fmtKes(Math.max(tv-tp,0))}`);
        doc.end();
        return;
      }

      // ── Customer receivables ───────────────────────────────────────────────
      const customerReceivables = data.customerReceivables;
      if (customerReceivables != null) {
        doc = new PDFDocument({ size: [LW, LH], autoFirstPage: false, margin: 0 });
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const cols = CUSTOMER_REC_COLS;
        const rows = customerReceivables.map(cust => {
          const cl    = parseFloat(cust.credit_limit || 0);
          const out   = parseFloat(cust.outstanding  || 0);
          const avail = Math.max(cl - out, 0);
          return {
            name:         cust.name || '',
            terms:        cust.credit_terms || '',
            total_sales:  fmtKes(cust.total_sales || 0),
            outstanding:  fmtKes(out),
            overdue:      fmtKes(cust.overdue || 0),
            credit_limit: cl > 0 ? fmtKes(cl) : '—',
            avail:        cl > 0 ? fmtKes(avail) : '—',
            orders:       String(cust.total_orders || 0),
          };
        });

        let pageNum = 1;
        doc.addPage();
        let y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum);
        y = drawSectionBar(doc, y, 'CUSTOMER RECEIVABLES');
        y = drawColHeaders(doc, y, cols);

        rows.forEach((row, idx) => {
          if (y + ROW_H > LH - LBOTTOM) {
            doc.addPage(); pageNum++;
            y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum);
            y = drawSectionBar(doc, y, 'CUSTOMER RECEIVABLES (continued)');
            y = drawColHeaders(doc, y, cols);
          }
          y = drawDataRow(doc, y, cols, row, idx);
        });

        if (y + 10 * MM > LH - LBOTTOM) { doc.addPage(); pageNum++; y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum); }
        const n = customerReceivables.length;
        const ts = customerReceivables.reduce((s, r) => s + parseFloat(r.total_sales || 0), 0);
        const to = customerReceivables.reduce((s, r) => s + parseFloat(r.outstanding || 0), 0);
        const td = customerReceivables.reduce((s, r) => s + parseFloat(r.overdue     || 0), 0);
        drawTotalsBar(doc, y + 2 * MM,
          `TOTAL  |  ${n} customer${n !== 1 ? 's' : ''}`,
          `Total Sales: KES ${fmtKes(ts)}   Outstanding: KES ${fmtKes(to)}   Overdue: KES ${fmtKes(td)}`);
        doc.end();
        return;
      }

      // ── Customer orders ───────────────────────────────────────────────────
      const customerOrders = data.customerOrders;
      if (customerOrders != null) {
        doc = new PDFDocument({ size: [LW, LH], autoFirstPage: false, margin: 0 });
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const cols = CUSTOMER_ORDER_COLS;
        const rows = customerOrders.map(o => {
          const tv  = parseFloat(o.total_value || 0);
          const pd  = parseFloat(o.amount_paid || 0);
          const bal = Math.max(tv - pd, 0);
          return {
            customer_name: o.customer_name || '',
            order_num:     o.order_num     || '',
            date:          fmtDate(o.created_at),
            due_date:      fmtDate(o.due_date),
            status:        o.status        || '',
            value:         fmtKes(tv),
            paid:          fmtKes(pd),
            balance:       fmtKes(bal),
          };
        });

        let pageNum = 1;
        doc.addPage();
        let y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum);
        y = drawSectionBar(doc, y, 'CUSTOMER ORDERS');
        y = drawColHeaders(doc, y, cols);

        rows.forEach((row, idx) => {
          if (y + ROW_H > LH - LBOTTOM) {
            doc.addPage(); pageNum++;
            y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum);
            y = drawSectionBar(doc, y, 'CUSTOMER ORDERS (continued)');
            y = drawColHeaders(doc, y, cols);
          }
          y = drawDataRow(doc, y, cols, row, idx);
        });

        if (y + 10 * MM > LH - LBOTTOM) { doc.addPage(); pageNum++; y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum); }
        const n   = customerOrders.length;
        const tv2 = customerOrders.reduce((s, o) => s + parseFloat(o.total_value || 0), 0);
        const tp2 = customerOrders.reduce((s, o) => s + parseFloat(o.amount_paid || 0), 0);
        drawTotalsBar(doc, y + 2 * MM,
          `TOTAL  |  ${n} order${n !== 1 ? 's' : ''}`,
          `Total Value: KES ${fmtKes(tv2)}   Collected: KES ${fmtKes(tp2)}   Outstanding: KES ${fmtKes(Math.max(tv2-tp2,0))}`);
        doc.end();
        return;
      }

      // ── Supplier statement (portrait A4) ──────────────────────────────────
      const supplierStatement = data.supplierStatement;
      if (supplierStatement != null) {
        doc = new PDFDocument({ size: [PW, PH], autoFirstPage: false, margin: 0 });
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const supplier = supplierStatement.supplier || {};
        const entries  = supplierStatement.entries  || [];
        const stats    = supplierStatement.stats    || {};

        const stmtRows = entries.map(e => {
          const debit  = parseFloat(e.debit   || 0);
          const credit = parseFloat(e.credit  || 0);
          const bal    = parseFloat(e.balance || 0);
          return {
            date:        fmtDate(e.date),
            type:        e.type        || '',
            description: e.description || '—',
            debit:       debit  > 0 ? fmtKes(debit)  : '—',
            credit:      credit > 0 ? fmtKes(credit) : '—',
            balance:     fmtKes(Math.abs(bal)) + (bal < 0 ? ' CR' : ''),
          };
        });

        let pageNum = 1;
        doc.addPage();
        let y = drawPortraitSupplierHeader(doc, subtitle, nowStr, userName, pageNum, true, supplier);

        // Section bar
        fillRect(doc, PM, y, PCW, 7 * MM, '#000000');
        drawLeft(doc, 'TRANSACTION HISTORY', PM, y + 1.5 * MM,
          { font: 'Helvetica-Bold', size: 7.5, color: WHITE });
        y += 7 * MM;

        // Col headers
        fillRect(doc, PM, y, PCW, HDR_H, DKROW);
        STMT_COLS.forEach(col => {
          const x = PM + col.x;
          const opts = { font: 'Helvetica-Bold', size: 6.5, color: WHITE, maxW: col.w };
          if (col.right) drawRight(doc, col.header, x + col.w, y + 1.5 * MM, opts);
          else           drawLeft(doc, col.header, x, y + 1.5 * MM, opts);
        });
        y += HDR_H;

        stmtRows.forEach((row, idx) => {
          if (y + ROW_H > PH - PBOTTOM) {
            doc.addPage(); pageNum++;
            y = drawPortraitSupplierHeader(doc, subtitle, nowStr, userName, pageNum, false, supplier);
            fillRect(doc, PM, y, PCW, HDR_H, DKROW);
            STMT_COLS.forEach(col => {
              const x = PM + col.x;
              const opts = { font: 'Helvetica-Bold', size: 6.5, color: WHITE, maxW: col.w };
              if (col.right) drawRight(doc, col.header, x + col.w, y + 1.5 * MM, opts);
              else           drawLeft(doc, col.header, x, y + 1.5 * MM, opts);
            });
            y += HDR_H;
          }
          fillRect(doc, PM, y, PCW, ROW_H, idx % 2 === 0 ? LGRAY : WHITE);
          doc.save().moveTo(PM, y + ROW_H).lineTo(PM + PCW, y + ROW_H).lineWidth(0.2).stroke(MGRAY).restore();
          STMT_COLS.forEach(col => {
            const x    = PM + col.x;
            const text = row[col.key] || '—';
            const font  = col.bold ? 'Helvetica-Bold' : 'Helvetica';
            const opts  = { font, size: 6.5, color: DGRAY, maxW: col.w };
            if (col.right) drawRight(doc, text, x + col.w, y + 1.5 * MM, opts);
            else           drawLeft(doc, text, x, y + 1.5 * MM, opts);
          });
          y += ROW_H;
        });

        if (y + 10 * MM > PH - PBOTTOM) { doc.addPage(); pageNum++; y = drawPortraitSupplierHeader(doc, subtitle, nowStr, userName, pageNum, false, supplier); }
        const finalBal = entries.length ? parseFloat(entries[entries.length - 1].balance || 0) : 0;
        const balStr   = fmtKes(Math.abs(finalBal)) + (finalBal < 0 ? ' CR' : '');
        const n        = entries.length;
        fillRect(doc, PM, y + 2 * MM, PCW, 8 * MM, CORAL);
        drawLeft(doc, `CLOSING BALANCE  |  ${n} transaction${n !== 1 ? 's' : ''}`,
          PM, y + 3.5 * MM, { font: 'Helvetica-Bold', size: 7.5, color: WHITE });
        drawRight(doc, `Balance: KES ${balStr}`, PM + PCW, y + 3.5 * MM,
          { font: 'Helvetica-Bold', size: 7.5, color: WHITE });

        doc.end();
        return;
      }

      // ── Customer statement (portrait A4) ──────────────────────────────────
      const customerStatement = data.customerStatement;
      if (customerStatement != null) {
        doc = new PDFDocument({ size: [PW, PH], autoFirstPage: false, margin: 0 });
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const cust    = customerStatement.customer || {};
        const entries = customerStatement.entries  || [];

        const stmtRows = entries.map(e => {
          const debit  = parseFloat(e.debit   || 0);
          const credit = parseFloat(e.credit  || 0);
          const bal    = parseFloat(e.balance || 0);
          return {
            date:        fmtDate(e.date),
            type:        e.type        || '',
            description: e.description || '—',
            debit:       debit  > 0 ? fmtKes(debit)  : '—',
            credit:      credit > 0 ? fmtKes(credit) : '—',
            balance:     fmtKes(Math.abs(bal)) + (bal < 0 ? ' CR' : ''),
          };
        });

        let pageNum = 1;
        doc.addPage();
        let y = drawPortraitHeader(doc, subtitle, nowStr, userName, pageNum, true, cust);

        // Section bar
        fillRect(doc, PM, y, PCW, 7 * MM, '#000000');
        drawLeft(doc, 'TRANSACTION HISTORY', PM, y + 1.5 * MM,
          { font: 'Helvetica-Bold', size: 7.5, color: WHITE });
        y += 7 * MM;

        // Col headers
        fillRect(doc, PM, y, PCW, HDR_H, DKROW);
        STMT_COLS.forEach(col => {
          const x = PM + col.x;
          const opts = { font: 'Helvetica-Bold', size: 6.5, color: WHITE, maxW: col.w };
          if (col.right) drawRight(doc, col.header, x + col.w, y + 1.5 * MM, opts);
          else           drawLeft(doc, col.header, x, y + 1.5 * MM, opts);
        });
        y += HDR_H;

        stmtRows.forEach((row, idx) => {
          if (y + ROW_H > PH - PBOTTOM) {
            doc.addPage(); pageNum++;
            y = drawPortraitHeader(doc, subtitle, nowStr, userName, pageNum, false, cust);
            fillRect(doc, PM, y, PCW, HDR_H, DKROW);
            STMT_COLS.forEach(col => {
              const x = PM + col.x;
              const opts = { font: 'Helvetica-Bold', size: 6.5, color: WHITE, maxW: col.w };
              if (col.right) drawRight(doc, col.header, x + col.w, y + 1.5 * MM, opts);
              else           drawLeft(doc, col.header, x, y + 1.5 * MM, opts);
            });
            y += HDR_H;
          }
          // Row bg
          fillRect(doc, PM, y, PCW, ROW_H, idx % 2 === 0 ? LGRAY : WHITE);
          doc.save().moveTo(PM, y + ROW_H).lineTo(PM + PCW, y + ROW_H).lineWidth(0.2).stroke(MGRAY).restore();
          STMT_COLS.forEach(col => {
            const x    = PM + col.x;
            const text = row[col.key] || '—';
            const font  = col.bold ? 'Helvetica-Bold' : 'Helvetica';
            const opts  = { font, size: 6.5, color: DGRAY, maxW: col.w };
            if (col.right) drawRight(doc, text, x + col.w, y + 1.5 * MM, opts);
            else           drawLeft(doc, text, x, y + 1.5 * MM, opts);
          });
          y += ROW_H;
        });

        // Closing balance bar
        if (y + 10 * MM > PH - PBOTTOM) { doc.addPage(); pageNum++; y = drawPortraitHeader(doc, subtitle, nowStr, userName, pageNum, false, cust); }
        const finalBal = entries.length ? parseFloat(entries[entries.length - 1].balance || 0) : 0;
        const balStr   = fmtKes(Math.abs(finalBal)) + (finalBal < 0 ? ' CR' : '');
        const n        = entries.length;
        fillRect(doc, PM, y + 2 * MM, PCW, 8 * MM, CORAL);
        drawLeft(doc, `CLOSING BALANCE  |  ${n} transaction${n !== 1 ? 's' : ''}`,
          PM, y + 3.5 * MM, { font: 'Helvetica-Bold', size: 7.5, color: WHITE });
        drawRight(doc, `Balance: KES ${balStr}`, PM + PCW, y + 3.5 * MM,
          { font: 'Helvetica-Bold', size: 7.5, color: WHITE });

        doc.end();
        return;
      }

      // ── Order P&L ─────────────────────────────────────────────────────────
      const orderPnL = data.orderPnL;
      if (orderPnL != null) {
        doc = new PDFDocument({ size: [LW, LH], autoFirstPage: false, margin: 0 });
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const cols    = ORDER_PNL_COLS;
        // Sub-row height is slightly smaller than main ROW_H
        const SUB_H   = 5.5 * MM;
        const CORAL_A = '#E8512A';

        // Helper to draw a purchase sub-row under an order summary row
        function drawPurchaseSubRow(doc, y, p, isLast) {
          const subBg = '#FAF8F6';
          fillRect(doc, LM, y, LCW, SUB_H, subBg);
          if (!isLast) {
            doc.save().moveTo(LM, y + SUB_H).lineTo(LM + LCW, y + SUB_H).lineWidth(0.15).stroke('#EDE9E3').restore();
          }
          // Coral arrow indicator
          doc.font('Helvetica-Bold').fontSize(6).fillColor(CORAL_A)
            .text('>>', LM + 3 * MM, y + 1.2 * MM, { lineBreak: false });
          // Supplier name (bold)
          const supplierText = String(p.supplier_name || '—');
          const dateStr = p.purchase_date ? fmtDate(p.purchase_date) : '';
          const metaText = dateStr ? `${supplierText}  ·  ${dateStr}` : supplierText;
          drawLeft(doc, metaText, LM + 7 * MM, y + 1.2 * MM, { font: 'Helvetica-Bold', size: 5.5, color: '#555', maxW: 70 * MM });
          // Items description
          drawLeft(doc, p.items_bought || '—', LM + 80 * MM, y + 1.2 * MM, { size: 5.5, color: '#888', maxW: 90 * MM });
          // Cost right-aligned to 'costs' column
          const costsCol = cols.find(c => c.key === 'costs');
          if (costsCol) {
            drawRight(doc, fmtKes(parseFloat(p.total_amount || 0)),
              LM + costsCol.x + costsCol.w, y + 1.2 * MM,
              { font: 'Helvetica-Bold', size: 5.5, color: '#C62828', maxW: costsCol.w });
          }
          return y + SUB_H;
        }

        let pageNum = 1;
        doc.addPage();
        let y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum);
        y = drawSectionBar(doc, y, 'ORDER P&L  —  DIRECT MATERIAL COSTS ONLY');
        y = drawColHeaders(doc, y, cols);

        orderPnL.forEach((o, idx) => {
          const revenue   = parseFloat(o.revenue       || 0);
          const costs     = parseFloat(o.material_cost || 0);
          const collected = parseFloat(o.collected     || 0);
          const profit    = revenue - costs;
          const margin    = revenue > 0 ? (profit / revenue * 100) : 0;
          const purchases = Array.isArray(o.purchases) ? o.purchases : [];
          const neededH   = ROW_H + purchases.length * SUB_H + 2 * MM;

          if (y + neededH > LH - LBOTTOM) {
            doc.addPage(); pageNum++;
            y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum);
            y = drawSectionBar(doc, y, 'ORDER P&L (continued)');
            y = drawColHeaders(doc, y, cols);
          }

          const row = {
            order_num: o.order_num || '—',
            client:    o.client    || '—',
            status:    o.status    || '—',
            revenue:   fmtKes(revenue),
            collected: fmtKes(collected),
            costs:     costs > 0 ? fmtKes(costs) : '—',
            profit:    fmtKes(profit),
            margin:    margin.toFixed(1) + '%',
          };

          // Summary row — no bottom border if sub-rows follow
          const totalW = cols.reduce((s, c) => Math.max(s, c.x + c.w), 0);
          fillRect(doc, LM, y, totalW, ROW_H, idx % 2 === 0 ? LGRAY : WHITE);
          if (purchases.length === 0) {
            doc.save().moveTo(LM, y + ROW_H).lineTo(LM + totalW, y + ROW_H).lineWidth(0.2).stroke(MGRAY).restore();
          }
          cols.forEach(col => {
            const raw  = row[col.key];
            const text = (raw === null || raw === undefined || raw === '') ? '—' : String(raw);
            const font  = col.bold ? 'Helvetica-Bold' : 'Helvetica';
            const size  = col.size || 6.5;
            const x     = LM + col.x;
            const opts  = { font, size, color: DGRAY, maxW: col.w };
            if (col.right)   drawRight(doc, text, x + col.w, y + 1.5 * MM, opts);
            else if (col.centre) drawCenter(doc, text, x + col.w / 2, y + 1.5 * MM, opts);
            else             drawLeft(doc, text, x, y + 1.5 * MM, opts);
          });
          y += ROW_H;

          // Purchase sub-rows
          purchases.forEach((p, pIdx) => {
            y = drawPurchaseSubRow(doc, y, p, pIdx === purchases.length - 1);
          });
          // Separator after last sub-row
          if (purchases.length > 0) {
            doc.save().moveTo(LM, y).lineTo(LM + LCW, y).lineWidth(0.4).stroke(MGRAY).restore();
            y += 1 * MM;
          }
        });

        if (y + 10 * MM > LH - LBOTTOM) { doc.addPage(); pageNum++; y = drawLandscapeHeader(doc, reportLabel, subtitle, nowStr, userName, pageNum); }
        const n         = orderPnL.length;
        const totalRev  = orderPnL.reduce((s, o) => s + parseFloat(o.revenue       || 0), 0);
        const totalCost = orderPnL.reduce((s, o) => s + parseFloat(o.material_cost || 0), 0);
        const totalProf = totalRev - totalCost;
        const avgMargin = totalRev > 0 ? (totalProf / totalRev * 100) : 0;
        drawTotalsBar(doc, y + 2 * MM,
          `TOTAL  |  ${n} order${n !== 1 ? 's' : ''}  |  Avg Margin: ${avgMargin.toFixed(1)}%`,
          `Revenue: KES ${fmtKes(totalRev)}   Costs: KES ${fmtKes(totalCost)}   Gross Profit: KES ${fmtKes(totalProf)}`);
        doc.end();
        return;
      }

      // ── Single-Order P&L (portrait A4) ───────────────────────────────────
      const singleOrderPnL = data.singleOrderPnL;
      if (singleOrderPnL != null) {
        const order            = singleOrderPnL.order            || {};
        const purchases        = singleOrderPnL.purchases        || [];
        const labourAllocations = singleOrderPnL.labourAllocations || [];
        const chargeItems      = singleOrderPnL.chargeItems      || [];
        const itemsSubtotal    = parseFloat(singleOrderPnL.itemsSubtotal || 0);
        const hasUnallocated   = !!singleOrderPnL.hasUnallocated;
        const directExpenses = singleOrderPnL.directExpenses || [];
        const { contractTotal, totalPurchaseCost, totalLabourCost, totalDirectExpenses,
                totalCost, grossProfit, orderProfit, margin, totalPaid, outstanding } =
          singleOrderPnL.totals || {};
        const userName    = singleOrderPnL.userName || '';

        const profitPos   = parseFloat(orderProfit ?? grossProfit ?? 0) >= 0;
        const summaryClr  = profitPos ? '#16a34a' : '#CC0000';
        const now         = new Date();
        const nowStr      = fmtDate(now.toISOString());

        doc = new PDFDocument({ size: [PW, PH], autoFirstPage: false, margin: 0 });
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        let pnlPage = 0;
        function drawPnLHeader() {
          pnlPage++;
          doc.addPage();
          fillRect(doc, 0, 0, PW, 13 * MM, CORAL);
          drawLeft(doc, 'CANVAS GUY LIMITED', PM, 4 * MM,
            { font: 'Helvetica-Bold', size: 10, color: WHITE });
          drawRight(doc, 'Ruiru - Gwa Kairo Thome Rd  |  Kiambu County, Kenya  |  holla@canvasguy.co.ke  |  0713 196 650',
            PW - PM, 5.5 * MM, { size: 6.5, color: WHITE });
          let hy = 16 * MM;
          drawLeft(doc, 'ORDER P&L', PM, hy, { font: 'Helvetica-Bold', size: 11, color: DGRAY });
          drawRight(doc, `${nowStr}   |   Page ${pnlPage}`, PW - PM, hy, { size: 7, color: DGRAY });
          hy += 5 * MM;
          if (userName) drawRight(doc, `Prepared by: ${userName}`, PW - PM, hy, { size: 7, color: DGRAY });
          hy += 4 * MM;
          doc.save().moveTo(PM, hy).lineTo(PW - PM, hy).lineWidth(0.4).stroke(MGRAY).restore();
          hy += 3 * MM;
          return hy;
        }

        let y = drawPnLHeader();

        // ── Order info box ──────────────────────────────────────────────
        const boxH = 18 * MM;
        fillRect(doc, PM, y, PCW, boxH, LGRAY);
        drawLeft(doc,
          `${order.order_num || ''}  —  ${(order.client || '').toUpperCase()}`,
          PM + 3 * MM, y + 2.5 * MM,
          { font: 'Helvetica-Bold', size: 9, color: DGRAY });
        drawLeft(doc, `Status: ${order.status || ''}`,
          PM + 3 * MM, y + 8 * MM, { size: 7, color: DGRAY });
        if (order.due_date) {
          drawLeft(doc, `Due: ${fmtDate(order.due_date)}`,
            PM + 3 * MM, y + 12.5 * MM, { size: 7, color: DGRAY });
        }
        y += boxH + 5 * MM;

        // ── Unallocated warning ─────────────────────────────────────────
        if (hasUnallocated) {
          fillRect(doc, PM, y, PCW, 8 * MM, '#FFFBEB');
          doc.save().rect(PM, y, PCW, 8 * MM).stroke('#FDE68A').restore();
          drawLeft(doc,
            '⚠  One or more purchases have no cost split set — costs may be overstated.',
            PM + 3 * MM, y + 2.5 * MM, { size: 6.5, color: '#92400e' });
          y += 10 * MM;
        }

        // ── KPI cards (4 across) ────────────────────────────────────────
        const cardW = (PCW - 3 * 3 * MM) / 4;
        const cardH = 18 * MM;
        const cards = [
          { label: 'CONTRACT TOTAL', val: `KES ${fmtKes(contractTotal)}`, clr: DGRAY },
          { label: 'TOTAL COSTS',    val: `KES ${fmtKes(totalCost)}`,     clr: CORAL },
          { label: (orderProfit ?? grossProfit) >= 0 ? 'ORDER PROFIT' : 'ORDER LOSS',
                                     val: `KES ${fmtKes(Math.abs(orderProfit ?? grossProfit))}`, clr: summaryClr },
          { label: 'ORDER MARGIN',   val: `${Math.round(margin)}%`,       clr: summaryClr },
        ];
        cards.forEach((c, i) => {
          const cx = PM + i * (cardW + 3 * MM);
          fillRect(doc, cx, y, cardW, cardH, LGRAY);
          fillRect(doc, cx, y, cardW, 2, c.clr);
          drawCenter(doc, c.label, cx + cardW / 2, y + 4 * MM,
            { font: 'Helvetica-Bold', size: 5.5, color: '#6b7280' });
          drawCenter(doc, c.val, cx + cardW / 2, y + 9 * MM,
            { font: 'Helvetica-Bold', size: 7.5, color: c.clr });
        });
        y += cardH + 6 * MM;

        // ── Revenue section ─────────────────────────────────────────────
        fillRect(doc, PM, y, PCW, 7 * MM, '#000000');
        drawLeft(doc, 'REVENUE', PM + 2 * MM, y + 1.5 * MM,
          { font: 'Helvetica-Bold', size: 7.5, color: CORAL });
        y += 7 * MM + 4 * MM;

        const RL = PM + 3 * MM;   // left x for revenue labels
        const RR = PW - PM;       // right x for revenue amounts
        const RH = 5 * MM;        // line height

        if (itemsSubtotal > 0) {
          drawLeft(doc,  'Items subtotal', RL, y, { size: 7, color: DGRAY });
          drawRight(doc, `KES ${fmtKes(itemsSubtotal)}`, RR, y, { size: 7, color: DGRAY });
          y += RH;
        }
        chargeItems.forEach(ci => {
          const amt = (parseFloat(ci.unit_price) || 0) * (parseInt(ci.quantity) || 1);
          drawLeft(doc,  ci.category || 'Charge', RL, y, { size: 7, color: DGRAY });
          drawRight(doc, `KES ${fmtKes(amt)}`, RR, y, { size: 7, color: DGRAY });
          y += RH;
        });
        // Divider
        doc.save().moveTo(RL, y).lineTo(RR, y).lineWidth(0.3).stroke(MGRAY).restore();
        y += 2 * MM;
        // Contract Total
        drawLeft(doc,  'Contract Total', RL, y, { font: 'Helvetica-Bold', size: 7.5, color: DGRAY });
        drawRight(doc, `KES ${fmtKes(contractTotal)}`, RR, y, { font: 'Helvetica-Bold', size: 7.5, color: DGRAY });
        y += RH + 1 * MM;
        // Received
        drawLeft(doc,  'Received from client', RL, y, { size: 7, color: '#16a34a' });
        drawRight(doc, `KES ${fmtKes(totalPaid)}`, RR, y, { size: 7, color: '#16a34a' });
        y += RH;
        // Outstanding
        const outClr = outstanding > 0.01 ? CORAL : '#16a34a';
        drawLeft(doc,  'Outstanding (receivable)', RL, y, { size: 7, color: outClr });
        drawRight(doc, `KES ${fmtKes(outstanding)}`, RR, y, { size: 7, color: outClr });
        y += 7 * MM;

        // ── Supplier Costs section ──────────────────────────────────────
        fillRect(doc, PM, y, PCW, 7 * MM, '#000000');
        drawLeft(doc,
          `SUPPLIER COSTS  —  ${purchases.length} purchase${purchases.length !== 1 ? 's' : ''} linked`,
          PM + 2 * MM, y + 1.5 * MM,
          { font: 'Helvetica-Bold', size: 7.5, color: CORAL });
        y += 7 * MM;

        if (purchases.length === 0) {
          y += 3 * MM;
          drawLeft(doc, 'No supplier costs linked to this order yet.', PM + 3 * MM, y,
            { size: 7, color: '#9ca3af' });
          y += 8 * MM;
        } else {
          const COST_COLS = mmCols([
            { key: 'date',     header: 'Date',         x:   0, w: 22 },
            { key: 'supplier', header: 'Supplier',     x:  22, w: 40, bold: true },
            { key: 'items',    header: 'Items',        x:  62, w: 78 },
            { key: 'amount',   header: 'Amount (KES)', x: 140, w: 31, right: true, bold: true },
          ]);

          y += 2 * MM;
          fillRect(doc, PM, y, PCW, HDR_H, LGRAY);
          COST_COLS.forEach(c => {
            if (c.right)
              drawRight(doc, c.header, PM + c.x + c.w, y + 1.5 * MM,
                { font: 'Helvetica-Bold', size: 6.5, color: DGRAY });
            else
              drawLeft(doc, c.header, PM + c.x, y + 1.5 * MM,
                { font: 'Helvetica-Bold', size: 6.5, color: DGRAY });
          });
          y += HDR_H;

          purchases.forEach((p, idx) => {
            if (y + ROW_H > PH - PBOTTOM - 22 * MM) { y = drawPnLHeader(); }
            if (idx % 2 === 1) fillRect(doc, PM, y, PCW, ROW_H, '#FAFAFA');
            const ry = y + 1.5 * MM;
            drawLeft(doc,  fmtDate(p.purchase_date), PM + COST_COLS[0].x, ry,
              { size: 6.5, color: DGRAY });
            drawLeft(doc,  p.supplier?.name || '—', PM + COST_COLS[1].x, ry,
              { size: 6.5, color: DGRAY, maxW: COST_COLS[1].w });
            drawLeft(doc,  p.items_bought || '—', PM + COST_COLS[2].x, ry,
              { size: 6.5, color: DGRAY, maxW: COST_COLS[2].w });
            drawRight(doc, fmtKes(p.total_amount),
              PM + COST_COLS[3].x + COST_COLS[3].w, ry,
              { font: 'Helvetica-Bold', size: 6.5, color: DGRAY });
            y += ROW_H;
          });

          // Subtotal row — supplier costs only
          fillRect(doc, PM, y, PCW, ROW_H, DKROW);
          drawLeft(doc,  'SUPPLIER COSTS TOTAL', PM + 2 * MM, y + 1.5 * MM,
            { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
          drawRight(doc, `KES ${fmtKes(totalPurchaseCost)}`, PW - PM, y + 1.5 * MM,
            { font: 'Helvetica-Bold', size: 7, color: CORAL });
          y += ROW_H + 4 * MM;
        }

        // ── Labour Costs section ────────────────────────────────────────
        fillRect(doc, PM, y, PCW, 7 * MM, '#000000');
        drawLeft(doc,
          `LABOUR COSTS  —  ${labourAllocations.length} allocation${labourAllocations.length !== 1 ? 's' : ''}`,
          PM + 2 * MM, y + 1.5 * MM,
          { font: 'Helvetica-Bold', size: 7.5, color: CORAL });
        y += 7 * MM;

        if (labourAllocations.length === 0) {
          y += 3 * MM;
          drawLeft(doc, 'No skilled-labour costs linked to this order.', PM + 3 * MM, y,
            { size: 7, color: '#9ca3af' });
          y += 8 * MM;
        } else {
          const LAB_COLS = mmCols([
            { key: 'worker', header: 'Worker',      x:   0, w: 55, bold: true },
            { key: 'run',    header: 'Payroll Run', x:  55, w: 45 },
            { key: 'notes',  header: 'Notes',       x: 100, w: 55 },
            { key: 'amount', header: 'Amount (KES)',x: 140, w: 31, right: true, bold: true },
          ]);

          y += 2 * MM;
          fillRect(doc, PM, y, PCW, HDR_H, LGRAY);
          LAB_COLS.forEach(c => {
            if (c.right)
              drawRight(doc, c.header, PM + c.x + c.w, y + 1.5 * MM,
                { font: 'Helvetica-Bold', size: 6.5, color: DGRAY });
            else
              drawLeft(doc, c.header, PM + c.x, y + 1.5 * MM,
                { font: 'Helvetica-Bold', size: 6.5, color: DGRAY });
          });
          y += HDR_H;

          labourAllocations.forEach((l, idx) => {
            if (y + ROW_H > PH - PBOTTOM - 22 * MM) { y = drawPnLHeader(); }
            if (idx % 2 === 1) fillRect(doc, PM, y, PCW, ROW_H, '#FAFAFA');
            const ry = y + 1.5 * MM;
            drawLeft(doc,  l.worker_name || '—', PM + LAB_COLS[0].x, ry,
              { size: 6.5, color: DGRAY, maxW: LAB_COLS[0].w });
            drawLeft(doc,  l.run_num || '—', PM + LAB_COLS[1].x, ry,
              { size: 6.5, color: DGRAY });
            drawLeft(doc,  l.notes || '—', PM + LAB_COLS[2].x, ry,
              { size: 6.5, color: DGRAY, maxW: LAB_COLS[2].w });
            drawRight(doc, fmtKes(l.allocated_amount),
              PM + LAB_COLS[3].x + LAB_COLS[3].w, ry,
              { font: 'Helvetica-Bold', size: 6.5, color: DGRAY });
            y += ROW_H;
          });

          // Labour subtotal
          fillRect(doc, PM, y, PCW, ROW_H, DKROW);
          drawLeft(doc,  'LABOUR COSTS TOTAL', PM + 2 * MM, y + 1.5 * MM,
            { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
          drawRight(doc, `KES ${fmtKes(totalLabourCost)}`, PW - PM, y + 1.5 * MM,
            { font: 'Helvetica-Bold', size: 7, color: CORAL });
          y += ROW_H + 4 * MM;
        }

        // ── Supplier + Labour subtotal ──────────────────────────────────
        fillRect(doc, PM, y, PCW, ROW_H + 1 * MM, '#374151');
        drawLeft(doc,  'GROSS PROFIT  (Contract − Supplier − Labour)', PM + 2 * MM, y + 2 * MM,
          { font: 'Helvetica-Bold', size: 7, color: WHITE });
        drawRight(doc, `KES ${fmtKes(parseFloat(grossProfit || 0))}`, PW - PM, y + 2 * MM,
          { font: 'Helvetica-Bold', size: 7.5, color: parseFloat(grossProfit||0)>=0 ? '#4ade80' : '#f87171' });
        y += ROW_H + 1 * MM + 6 * MM;

        // ── Direct Expenses section ─────────────────────────────────────
        if (y + 10 * MM > PH - PBOTTOM) { y = drawPnLHeader(); }
        fillRect(doc, PM, y, PCW, 7 * MM, '#000000');
        drawLeft(doc,
          `DIRECT ORDER EXPENSES  —  ${directExpenses.length} expense${directExpenses.length !== 1 ? 's' : ''}`,
          PM + 2 * MM, y + 1.5 * MM,
          { font: 'Helvetica-Bold', size: 7.5, color: CORAL });
        y += 7 * MM;

        if (directExpenses.length === 0) {
          y += 3 * MM;
          drawLeft(doc, 'No direct expenses recorded for this order.', PM + 3 * MM, y,
            { size: 7, color: '#9ca3af' });
          y += 8 * MM;
        } else {
          const EXP_COLS = mmCols([
            { key: 'date',     header: 'Date',       x:   0, w: 22 },
            { key: 'category', header: 'Category',   x:  22, w: 40, bold: true },
            { key: 'desc',     header: 'Description',x:  62, w: 68 },
            { key: 'status',   header: 'Status',     x: 130, w: 18 },
            { key: 'amount',   header: 'Amount (KES)',x: 148, w: 23, right: true, bold: true },
          ]);

          y += 2 * MM;
          fillRect(doc, PM, y, PCW, HDR_H, LGRAY);
          EXP_COLS.forEach(c => {
            if (c.right)
              drawRight(doc, c.header, PM + c.x + c.w, y + 1.5 * MM,
                { font: 'Helvetica-Bold', size: 6.5, color: DGRAY });
            else
              drawLeft(doc, c.header, PM + c.x, y + 1.5 * MM,
                { font: 'Helvetica-Bold', size: 6.5, color: DGRAY });
          });
          y += HDR_H;

          directExpenses.forEach((e, idx) => {
            if (y + ROW_H > PH - PBOTTOM - 22 * MM) { y = drawPnLHeader(); }
            if (idx % 2 === 1) fillRect(doc, PM, y, PCW, ROW_H, '#FAFAFA');
            const ry = y + 1.5 * MM;
            drawLeft(doc,  fmtDate(e.expense_date), PM + EXP_COLS[0].x, ry,
              { size: 6.5, color: DGRAY });
            drawLeft(doc,  e.category || '—', PM + EXP_COLS[1].x, ry,
              { size: 6.5, color: DGRAY, maxW: EXP_COLS[1].w });
            drawLeft(doc,  e.description || '—', PM + EXP_COLS[2].x, ry,
              { size: 6.5, color: DGRAY, maxW: EXP_COLS[2].w });
            const sClr = e.payment_status === 'paid' ? '#16a34a' : CORAL;
            drawLeft(doc,  e.payment_status === 'paid' ? 'Paid' : 'Unpaid',
              PM + EXP_COLS[3].x, ry, { size: 6, color: sClr });
            drawRight(doc, fmtKes(e.allocated_amount),
              PM + EXP_COLS[4].x + EXP_COLS[4].w, ry,
              { font: 'Helvetica-Bold', size: 6.5, color: DGRAY });
            y += ROW_H;
          });

          // Direct expenses total row
          fillRect(doc, PM, y, PCW, ROW_H, DKROW);
          drawLeft(doc,  'DIRECT EXPENSES TOTAL', PM + 2 * MM, y + 1.5 * MM,
            { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
          drawRight(doc, `KES ${fmtKes(parseFloat(totalDirectExpenses||0))}`, PW - PM, y + 1.5 * MM,
            { font: 'Helvetica-Bold', size: 7, color: CORAL });
          y += ROW_H + 4 * MM;
        }

        // ── Order Profit / Loss bar ─────────────────────────────────────
        if (y + 18 * MM > PH - PBOTTOM) { y = drawPnLHeader(); }
        fillRect(doc, PM, y, PCW, 16 * MM, summaryClr);
        const gpLabel = profitPos ? 'ORDER PROFIT' : 'ORDER LOSS';
        const displayProfit = parseFloat(orderProfit ?? grossProfit ?? 0);
        drawLeft(doc, gpLabel, PM + 4 * MM, y + 3.5 * MM,
          { font: 'Helvetica-Bold', size: 8, color: WHITE });
        drawLeft(doc, `KES ${fmtKes(Math.abs(displayProfit))}`, PM + 4 * MM, y + 9 * MM,
          { font: 'Helvetica-Bold', size: 11, color: WHITE });
        drawRight(doc, `${Math.round(margin)}%`, PW - PM - 4 * MM, y + 5 * MM,
          { font: 'Helvetica-Bold', size: 18, color: WHITE });
        y += 16 * MM + 2.5 * MM;
        drawRight(doc, 'Order Margin', PW - PM - 4 * MM, y, { size: 6, color: summaryClr });

        doc.end();
        return;
      }

      // ── Delivery note (portrait A4) ───────────────────────────────────────
      const deliveryNote = data.deliveryNote;
      if (deliveryNote != null) {
        const order       = deliveryNote.order    || {};
        const items       = deliveryNote.items    || [];
        const batch       = deliveryNote.batch    || null;
        const payments    = deliveryNote.payments || [];
        const showAmounts = !!deliveryNote.showAmounts;

        const CHARGE_CATS  = new Set(['Delivery Fee','Installation Fee','Design Fee','Rush Fee','Discount']);
        const regularItems = items.filter(i => !CHARGE_CATS.has(i.category));
        const chargeItems  = items.filter(i =>  CHARGE_CATS.has(i.category));

        const totalPaid     = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
        const contractTotal = parseFloat(order.total_value || 0);
        const balance       = Math.max(contractTotal - totalPaid, 0);
        const totalPieces   = regularItems.reduce((s, i) => s + (parseInt(i.quantity) || 0), 0);
        const itemsSubtotal = regularItems.reduce((s, i) =>
          s + (parseFloat(i.unit_price) || 0) * (parseInt(i.quantity) || 1), 0);

        const batchNum  = batch ? batch.batch_number : null;
        const delivLoc  = (batch && batch.delivery_location) || order.delivery_address || null;
        const delivDate = batch
          ? (batch.actual_delivery_date || batch.planned_date || order.due_date)
          : order.due_date;
        const docTitle  = showAmounts ? 'INTERNAL COPY' : 'DELIVERY NOTE';

        // ── Column definitions (mm, relative to PM) ───────────────────────
        const DN_BASIC = mmCols([
          { key: 'idx',      header: '#',                  x:   0, w:  7, centre: true },
          { key: 'category', header: 'Category',           x:   7, w: 32, bold: true },
          { key: 'spec',     header: 'Description / Spec', x:  39, w: 95 },
          { key: 'qty',      header: 'Qty',                x: 134, w: 16, centre: true, bold: true },
        ]);
        const DN_AMOUNTS = mmCols([
          { key: 'idx',       header: '#',                  x:   0, w:  7, centre: true },
          { key: 'category',  header: 'Category',           x:   7, w: 28, bold: true },
          { key: 'spec',      header: 'Description / Spec', x:  35, w: 73 },
          { key: 'qty',       header: 'Qty',                x: 108, w: 12, centre: true, bold: true },
          { key: 'unit_price',header: 'Unit Price',         x: 120, w: 27, right: true },
          { key: 'total',     header: 'Total',              x: 147, w: 27, right: true, bold: true },
        ]);
        const dnCols = showAmounts ? DN_AMOUNTS : DN_BASIC;
        const DN_ROW  = 7 * MM;
        const DN_HDR  = 7 * MM;
        const DN_BOT  = 24 * MM; // reserve space for sig block at page bottom

        doc = new PDFDocument({ size: [PW, PH], autoFirstPage: false, margin: 0 });
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.addPage();

        // ── Page header (reused on continuation pages) ────────────────────
        // Logo sits on white; coral band starts right after the logo.
        const LOGO_W  = 11 * MM;  // logo render width
        const BAND_X  = PM + LOGO_W + 2 * MM;  // coral band left edge

        function drawDnHeader() {
          // Full-bleed dark strip at very top for premium framing
          fillRect(doc, 0, 0, PW, 2 * MM, '#0F172A');

          // Coral band starts AFTER the logo so the logo is visible on white
          fillRect(doc, BAND_X, 2 * MM, PW - BAND_X, 14 * MM, CORAL);

          // Logo — SAME position for both Delivery Note and Internal Copy
          if (HAS_LOGO) {
            try { doc.image(LOGO_PATH, PM, 2.5 * MM, { fit: [LOGO_W, LOGO_W] }); } catch (_) {}
          }

          // Company name + contact in coral band
          drawLeft(doc, 'CANVAS GUY LIMITED', BAND_X + 3 * MM, 4 * MM,
            { font: 'Helvetica-Bold', size: 10, color: WHITE });
          drawLeft(doc, 'holla@canvasguy.co.ke  ·  Ruiru, Kiambu County  ·  0713 196 650',
            BAND_X + 3 * MM, 10 * MM, { size: 5.5, color: '#FFD0C0' });

          // Document title far right — only this differs between variants
          doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE)
            .text(docTitle, PM, 4.5 * MM, { width: PCW, align: 'right', lineBreak: false });
          if (showAmounts) {
            doc.font('Helvetica').fontSize(5).fillColor('#FFD0C0')
              .text('● CONFIDENTIAL', PM, 11 * MM, { width: PCW, align: 'right', lineBreak: false });
          }
          return 18 * MM;
        }

        let y = drawDnHeader();

        // ── Order number bar (dark) ──────────────────────────────────────
        const orderLine = [order.order_num, batchNum != null ? `Batch ${batchNum}` : null]
          .filter(Boolean).join(' · ');
        fillRect(doc, PM, y, PCW, 9.5 * MM, '#0F172A');
        // Coral left accent stripe
        fillRect(doc, PM, y, 2.5 * MM, 9.5 * MM, CORAL);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(WHITE)
          .text(orderLine, PM + 6 * MM, y + 2.6 * MM, { lineBreak: false });

        const todayFmt = fmtDate(new Date().toISOString().split('T')[0]);
        const dueLabel = batch ? `Delivery: ${fmtDate(delivDate)}` : `Due: ${fmtDate(delivDate)}`;
        doc.font('Helvetica').fontSize(6.5).fillColor('#94A3B8')
          .text(`${dueLabel}  ·  Issued: ${todayFmt}`, PM, y + 2.9 * MM,
            { width: PCW - 3 * MM, align: 'right', lineBreak: false });
        y += 13 * MM;

        // ── Deliver To + Logistics (2-column) ────────────────────────────
        const COL_W  = (PCW / 2) - 5 * MM;
        const COL2_X = PM + PCW / 2 + 5 * MM;
        let   ly     = y;  // left  column tracker
        let   ry     = y;  // right column tracker

        // Left: client block
        fillRect(doc, PM, ly, 2 * MM, 4 * MM, CORAL);
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(CORAL)
          .text('DELIVER TO', PM + 4 * MM, ly, { lineBreak: false });
        ly += 5.5 * MM;
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111')
          .text(order.client || '—', PM, ly, { width: COL_W, lineBreak: false });
        ly += 6 * MM;
        if (order.contact_person) {
          doc.font('Helvetica').fontSize(8).fillColor(DGRAY)
            .text(order.contact_person, PM, ly, { width: COL_W, lineBreak: false });
          ly += 4 * MM;
        }
        if (order.delivery_contact && order.delivery_contact !== order.contact_person) {
          doc.font('Helvetica').fontSize(8).fillColor(DGRAY)
            .text(order.delivery_contact, PM, ly, { width: COL_W, lineBreak: false });
          ly += 4 * MM;
        }
        if (delivLoc) {
          doc.font('Helvetica').fontSize(7.5).fillColor('#6B7280')
            .text(delivLoc, PM, ly, { width: COL_W });
          ly = doc.y + 2 * MM;
        }

        // Right: logistics / order detail fields
        fillRect(doc, COL2_X, ry, 2 * MM, 4 * MM, CORAL);
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(CORAL)
          .text(batch ? 'LOGISTICS' : 'ORDER DETAILS', COL2_X + 4 * MM, ry, { lineBreak: false });
        ry += 5.5 * MM;

        const rightFields = batch ? [
          { label: 'DRIVER',   value: batch.driver   || '—' },
          { label: 'VEHICLE',  value: batch.vehicle  || '—' },
          { label: 'DATE',     value: fmtDate(delivDate) },
          ...(showAmounts && order.invoice_number ? [{ label: 'INVOICE #', value: order.invoice_number }] : []),
        ] : [
          ...(order.quote_number   ? [{ label: 'QUOTE #',       value: order.quote_number }]   : []),
          ...(order.invoice_number ? [{ label: 'INVOICE #',     value: order.invoice_number }] : []),
          { label: 'SALES REP',      value: order.author        || '—' },
          { label: 'PAYMENT TERMS',  value: order.payment_terms || '—' },
        ];

        rightFields.forEach(({ label, value }) => {
          doc.font('Helvetica-Bold').fontSize(6).fillColor('#9CA3AF')
            .text(label, COL2_X, ry, { lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#111111')
            .text(String(value), COL2_X + 24 * MM, ry, { width: COL_W - 24 * MM, lineBreak: false });
          ry += 5 * MM;
        });

        y = Math.max(ly, ry) + 4 * MM;

        // ── Instructions boxes ────────────────────────────────────────────
        if (order.delivery_instructions) {
          const bxH = 10 * MM;
          fillRect(doc, PM, y, PCW, bxH, '#FFF7ED');
          doc.save().rect(PM, y, PCW, bxH).lineWidth(1).strokeColor('#FED7AA').stroke().restore();
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#92400E')
            .text('Special instructions: ', PM + 3 * MM, y + 3 * MM, { continued: true, lineBreak: false });
          doc.font('Helvetica').fontSize(7.5).fillColor('#92400E')
            .text(order.delivery_instructions, { lineBreak: false });
          y += bxH + 3 * MM;
        }
        if (batch && batch.notes) {
          const bxH = 10 * MM;
          fillRect(doc, PM, y, PCW, bxH, '#F0F9FF');
          doc.save().rect(PM, y, PCW, bxH).lineWidth(1).strokeColor('#BAE6FD').stroke().restore();
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#0369A1')
            .text('Batch notes: ', PM + 3 * MM, y + 3 * MM, { continued: true, lineBreak: false });
          doc.font('Helvetica').fontSize(7.5).fillColor('#0369A1')
            .text(batch.notes, { lineBreak: false });
          y += bxH + 3 * MM;
        }

        y += 2 * MM;

        // ── Section label + items table ───────────────────────────────────
        fillRect(doc, PM, y, 2 * MM, 4.5 * MM, CORAL);
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#374151')
          .text(`ITEMS${batchNum != null ? ` — BATCH ${batchNum}` : ''}`, PM + 4 * MM, y + 0.5 * MM, { lineBreak: false });
        y += 6.5 * MM;

        function drawDnTableHeader(atY) {
          fillRect(doc, PM, atY, PCW, DN_HDR, '#111827');
          dnCols.forEach(col => {
            const x    = PM + col.x;
            const opts = { font: 'Helvetica-Bold', size: 6.5, color: WHITE, maxW: col.w };
            if (col.right)       drawRight(doc, col.header, x + col.w, atY + 1.5 * MM, opts);
            else if (col.centre) drawCenter(doc, col.header, x + col.w / 2, atY + 1.5 * MM, opts);
            else                 drawLeft(doc, col.header, x, atY + 1.5 * MM, opts);
          });
          return atY + DN_HDR;
        }
        y = drawDnTableHeader(y);

        // Item rows
        regularItems.forEach((item, idx) => {
          if (y + DN_ROW > PH - DN_BOT) {
            doc.addPage();
            y = drawDnHeader() + 4 * MM;
            y = drawDnTableHeader(y);
          }
          fillRect(doc, PM, y, PCW, DN_ROW, idx % 2 === 0 ? LGRAY : WHITE);
          doc.save().moveTo(PM, y + DN_ROW).lineTo(PM + PCW, y + DN_ROW)
            .lineWidth(0.2).stroke(MGRAY).restore();

          const spec = [item.size, item.finish_type, item.finish_color, item.wood_type]
            .filter(Boolean).join(' · ') || item.description || '—';
          const rowTotal = (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1);
          const vals = {
            idx:        String(idx + 1),
            category:   item.category || '—',
            spec,
            qty:        String(parseInt(item.quantity) || 0),
            unit_price: `KES ${fmtKes(item.unit_price)}`,
            total:      `KES ${fmtKes(rowTotal)}`,
          };
          dnCols.forEach(col => {
            const x    = PM + col.x;
            const text = vals[col.key] || '—';
            const opts = { font: col.bold ? 'Helvetica-Bold' : 'Helvetica', size: 6.5, color: DGRAY, maxW: col.w };
            if (col.right)       drawRight(doc, text, x + col.w, y + 1.5 * MM, opts);
            else if (col.centre) drawCenter(doc, text, x + col.w / 2, y + 1.5 * MM, opts);
            else                 drawLeft(doc, text, x, y + 1.5 * MM, opts);
          });
          y += DN_ROW;
        });

        // ── Amounts footer (internal copy) ────────────────────────────────
        if (showAmounts) {
          // Items subtotal
          const subH = 6 * MM;
          fillRect(doc, PM, y, PCW, subH, WHITE);
          doc.save().moveTo(PM, y + subH).lineTo(PM + PCW, y + subH)
            .lineWidth(0.8).stroke('#E5E7EB').restore();
          drawRight(doc, `Items subtotal   KES ${fmtKes(itemsSubtotal)}`,
            PM + PCW, y + 1.5 * MM, { font: 'Helvetica', size: 7, color: '#6B7280', maxW: PCW });
          y += subH;

          chargeItems.forEach(ci => {
            const ciH = 5.5 * MM;
            fillRect(doc, PM, y, PCW, ciH, WHITE);
            doc.save().moveTo(PM, y + ciH).lineTo(PM + PCW, y + ciH)
              .lineWidth(0.2).stroke(MGRAY).restore();
            drawLeft(doc, ci.category, PM, y + 1 * MM, { size: 7, color: '#6B7280', maxW: PCW - 35 * MM });
            drawRight(doc, `KES ${fmtKes(ci.unit_price)}`, PM + PCW, y + 1 * MM,
              { size: 7, color: DGRAY, maxW: 35 * MM });
            y += ciH;
          });

          // Contract total dark bar
          fillRect(doc, PM, y, PCW, 8.5 * MM, '#111827');
          drawLeft(doc, 'CONTRACT TOTAL', PM + 2 * MM, y + 1.5 * MM,
            { font: 'Helvetica-Bold', size: 7.5, color: WHITE });
          drawRight(doc, `KES ${fmtKes(contractTotal)}`, PM + PCW, y + 1.5 * MM,
            { font: 'Helvetica-Bold', size: 9, color: CORAL, maxW: PCW });
          y += 11 * MM;
        }

        // ── Total pieces badge ────────────────────────────────────────────
        y += 3 * MM;
        const BADGE_W = 32 * MM;
        const BADGE_H = 17 * MM;
        const BADGE_X = PM + PCW - BADGE_W;
        fillRect(doc, BADGE_X, y, BADGE_W, BADGE_H, '#FFF5F2');
        doc.save().rect(BADGE_X, y, BADGE_W, BADGE_H).lineWidth(2).strokeColor(CORAL).stroke().restore();
        // Coral top accent strip
        fillRect(doc, BADGE_X, y, BADGE_W, 3.5 * MM, CORAL);
        doc.font('Helvetica-Bold').fontSize(5.5).fillColor(WHITE)
          .text('TOTAL PIECES', BADGE_X, y + 1 * MM, { width: BADGE_W, align: 'center', lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(22).fillColor(CORAL)
          .text(String(totalPieces), BADGE_X, y + 5.5 * MM, { width: BADGE_W, align: 'center', lineBreak: false });
        y += BADGE_H + 5 * MM;

        // ── Payment summary (internal only) ──────────────────────────────
        if (showAmounts) {
          const summaryCards = [
            { label: 'Contract Total', value: `KES ${fmtKes(contractTotal)}`, color: '#111111', accent: '#1F2937' },
            { label: 'Amount Paid',    value: `KES ${fmtKes(totalPaid)}`,     color: '#16A34A', accent: '#16A34A' },
            { label: 'Balance Due',    value: `KES ${fmtKes(balance)}`,       color: balance > 0 ? CORAL : '#16A34A', accent: balance > 0 ? CORAL : '#16A34A' },
          ];
          const CARD_GAP = 4 * MM;
          const CARD_W   = (PCW - 2 * CARD_GAP) / 3;
          const CARD_H   = 20 * MM;
          let cx = PM;
          summaryCards.forEach(({ label, value, color, accent }) => {
            const isBalance = label === 'Balance Due';
            const bgColor   = isBalance && balance > 0 ? '#FFF5F2' : '#F9FAFB';
            fillRect(doc, cx, y, CARD_W, CARD_H, bgColor);
            doc.save().rect(cx, y, CARD_W, CARD_H).lineWidth(1.5).strokeColor(accent).stroke().restore();
            // Top accent stripe
            fillRect(doc, cx, y, CARD_W, 2.5 * MM, accent);
            doc.font('Helvetica-Bold').fontSize(6).fillColor('#6B7280')
              .text(label.toUpperCase(), cx, y + 6 * MM, { width: CARD_W, align: 'center', lineBreak: false });
            doc.font('Helvetica-Bold').fontSize(11).fillColor(color)
              .text(value, cx, y + 12 * MM, { width: CARD_W, align: 'center', lineBreak: false });
            cx += CARD_W + CARD_GAP;
          });
          y += CARD_H + 5 * MM;
        }

        // ── Signature block ───────────────────────────────────────────────
        const SIG_H     = 30 * MM;
        fillRect(doc, PM, y, PCW, SIG_H, '#F9FAFB');
        // Coral top accent
        fillRect(doc, PM, y, PCW, 1.5 * MM, CORAL);
        const SIG_START = y + 5 * MM;
        const SIG_GAP   = 6 * MM;
        const SIG_W     = (PCW - 2 * SIG_GAP) / 3;
        ['Prepared by (Canvas Guy)', 'Delivered by', 'Received by (Client)'].forEach((label, i) => {
          const sx       = PM + i * (SIG_W + SIG_GAP);
          const sigLineY = SIG_START + 11 * MM;
          doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#6B7280')
            .text(label.toUpperCase(), sx, SIG_START, { width: SIG_W, lineBreak: false });
          // Dotted signature line
          doc.save().moveTo(sx, sigLineY).lineTo(sx + SIG_W, sigLineY)
            .lineWidth(0.75).dash(2, { space: 2 }).strokeColor('#374151').stroke().restore();
          doc.font('Helvetica').fontSize(6.5).fillColor('#9CA3AF')
            .text('Name & Date', sx, sigLineY + 2.5 * MM, { width: SIG_W, lineBreak: false });
        });
        y += SIG_H + 4 * MM;

        // ── Footer ────────────────────────────────────────────────────────
        fillRect(doc, PM, y, PCW, 1.5 * MM, CORAL);
        y += 4 * MM;
        doc.font('Helvetica').fontSize(6.5).fillColor('#9CA3AF')
          .text('Canvas Guy Limited  ·  Ruiru, Kiambu County, Kenya', PM, y, { lineBreak: false });
        const footRight = [order.order_num, showAmounts ? 'CONFIDENTIAL' : null].filter(Boolean).join(' · ');
        if (footRight) {
          doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#9CA3AF')
            .text(footRight, PM, y, { width: PCW, align: 'right', lineBreak: false });
        }

        doc.end();
        return;
      }

      // ── Quotation PDF (portrait A4, client-facing) ──────────────────────────
      if (data.quotationPdf != null) {
        doc = new PDFDocument({ size: [PW, PH], autoFirstPage: false, margin: 0 });
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.addPage();

        // ── Constants ──────────────────────────────────────────────────────────
        const TERMS_LABELS = {
          cash_before: 'Cash Before Production',
          deposit_50:  '50% Deposit, Balance on Delivery',
          on_delivery: 'On Delivery',
          net_30:      'Net 30 Days',
        };
        const CHARGE_LABELS = {
          delivery: 'Delivery',
          design:   'Design',
          discount: 'Discount',
          other:    'Other',
        };

        // ── Data ───────────────────────────────────────────────────────────────
        const quote       = data.quotationPdf.quote || {};
        const customer    = quote.customers || {};
        const sortedItems = (quote.quote_items || [])
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        const productItems    = sortedItems.filter(it => (it.line_type || 'product') === 'product');
        const additionalItems = sortedItems.filter(it => (it.line_type || 'product') !== 'product');
        const hasDiscount     = sortedItems.some(it => parseFloat(it.discount_pct || 0) > 0);

        const clientName    = customer.name           || quote.prospect_name    || '—';
        const clientContact = customer.contact_person || quote.prospect_contact || '';
        const clientPhone   = customer.phone          || '';
        const clientAddress = customer.address        || '';

        // ── Layout constants ───────────────────────────────────────────────────
        const ACCENT_W  = 2.5;          // coral left-accent bar width (pts)
        const COL_L     = PM;
        const COL_R     = PW / 2 + 4 * MM;
        const COL_W     = PW / 2 - PM - 4 * MM;
        const FOOTER_H  = 10 * MM;
        const BODY_BOTTOM = PH - FOOTER_H - 4 * MM; // lowest y we can draw body

        // Table column x-positions (all from left edge of page)
        // Fixed financial columns from the right; description gets whatever's left
        const T_RIGHT  = PW - PM;            // right edge
        const W_TOTAL  = 28 * MM;            // Total column
        const W_UP     = 28 * MM;            // Unit Price column
        const W_DISC   = hasDiscount ? 18 * MM : 0; // Discount column (conditional)
        const W_QTY    = 12 * MM;            // Qty
        const W_CAT    = 26 * MM;            // Category
        const W_NUM    = 7  * MM;            // #
        const C_NUM    = PM;
        const C_CAT    = C_NUM + W_NUM;
        const C_DESC   = C_CAT + W_CAT;
        const C_QTY    = T_RIGHT - W_TOTAL - W_UP - W_DISC - W_QTY;
        const C_DISC   = C_QTY  + W_QTY;
        const C_UP     = C_DISC + W_DISC;
        const C_TOTAL  = C_UP   + W_UP;
        const W_DESC   = C_QTY  - C_DESC - 2 * MM; // flexible

        const QT_HDR_H = 7 * MM;
        const QT_MIN_ROW = 8 * MM; // minimum row height

        // ── Page-break helper ──────────────────────────────────────────────────
        // Returns current y; if remaining space < needed, adds page + redraws header
        let qtLastHeaderY = 0;
        const ensureSpace = (currentY, needed, redrawHeader = false) => {
          if (currentY + needed > BODY_BOTTOM) {
            doc.addPage();
            // Thin repeat-header band at top of continuation page
            fillRect(doc, 0, 0, PW, 6 * MM, DKROW);
            doc.font('Helvetica-Bold').fontSize(7).fillColor(WHITE)
               .text(`${quote.quote_num || 'QUOTATION'}  —  continued`, PM, 1.5 * MM, { lineBreak: false });
            currentY = 8 * MM;
            if (redrawHeader) {
              currentY = qtDrawHeader(currentY);
              qtLastHeaderY = currentY;
            }
          }
          return currentY;
        };

        // ── Table header draw ──────────────────────────────────────────────────
        const qtDrawHeader = (yy) => {
          fillRect(doc, PM, yy, PCW, QT_HDR_H, DKROW);
          const hO = { font: 'Helvetica-Bold', size: 7, color: WHITE };
          drawCenter(doc, '#',           C_NUM  + W_NUM  / 2,  yy + 2 * MM, hO);
          drawLeft(doc,   'Category',    C_CAT  + 1.5 * MM,    yy + 2 * MM, hO);
          drawLeft(doc,   'Description / Spec', C_DESC + 1.5 * MM, yy + 2 * MM, hO);
          drawCenter(doc, 'Qty',         C_QTY  + W_QTY  / 2,  yy + 2 * MM, hO);
          if (hasDiscount) drawCenter(doc, 'Disc%', C_DISC + W_DISC / 2, yy + 2 * MM, hO);
          drawRight(doc,  'Unit Price',  C_UP   + W_UP,        yy + 2 * MM, hO);
          drawRight(doc,  'Total',       T_RIGHT,              yy + 2 * MM, hO);
          return yy + QT_HDR_H;
        };

        // ── Table row draw (dynamic height) ───────────────────────────────────
        const qtDrawRow = (yy, item, idx, forceCategory) => {
          const desc     = item.description || '—';
          const specParts = [item.size, item.finish_type, item.finish_color, item.wood_type].filter(Boolean);
          const specStr  = specParts.join(' · ');
          const discPct  = parseFloat(item.discount_pct || 0);

          // Measure how tall the description cell needs to be
          doc.font('Helvetica').fontSize(8);
          const descH   = doc.heightOfString(desc,   { width: W_DESC });
          doc.font('Helvetica').fontSize(6.5);
          const specH   = specStr ? doc.heightOfString(specStr, { width: W_DESC }) : 0;
          const PAD     = 3 * MM;
          const rowH    = Math.max(QT_MIN_ROW, descH + (specStr ? specH + 1.5 * MM : 0) + PAD * 2);

          const bg = idx % 2 === 0 ? WHITE : LGRAY;
          fillRect(doc, PM, yy, PCW, rowH, bg);

          const midV = yy + PAD; // top-align text with padding

          // # — vertically centred
          drawCenter(doc, idx + 1, C_NUM + W_NUM / 2, yy + rowH / 2 - 3, { size: 7 });

          // Category — vertically centred
          const cat = forceCategory || item.category || '—';
          drawLeft(doc, cat, C_CAT + 1.5 * MM, yy + rowH / 2 - 3, { size: 7.5, maxW: W_CAT - 2 * MM });

          // Description
          doc.font('Helvetica-Bold').fontSize(8).fillColor(DKROW)
             .text(desc, C_DESC + 1.5 * MM, midV, { width: W_DESC, lineBreak: false });
          if (specStr) {
            const specY = midV + descH + 1.5 * MM;
            doc.font('Helvetica').fontSize(6.5).fillColor('#9CA3AF')
               .text(specStr, C_DESC + 1.5 * MM, specY, { width: W_DESC, lineBreak: false });
          }

          // Qty — centred
          const qty = item.quantity ?? '—';
          drawCenter(doc, qty, C_QTY + W_QTY / 2, yy + rowH / 2 - 3, { font: 'Helvetica-Bold', size: 8 });

          // Discount
          if (hasDiscount) {
            const discStr = discPct > 0 ? `${discPct}%` : '—';
            drawCenter(doc, discStr, C_DISC + W_DISC / 2, yy + rowH / 2 - 3, { size: 7, color: discPct > 0 ? CORAL : '#AAAAAA' });
          }

          // Unit Price — right-aligned
          drawRight(doc, `KES ${fmtKes(item.unit_price)}`, C_UP + W_UP, yy + rowH / 2 - 3, { size: 7.5 });

          // Total — right-aligned, bold
          drawRight(doc, `KES ${fmtKes(item.gross_amount)}`, T_RIGHT, yy + rowH / 2 - 3,
            { font: 'Helvetica-Bold', size: 8, color: DKROW });

          return yy + rowH;
        };

        // ── 1. WHITE HEADER — logo + company info left, "QUOTATION" right ──────
        const LOGO_H    = 13 * MM;
        const LOGO_W    = 13 * MM;
        const LOGO_X    = PM;
        const LOGO_Y    = 3   * MM;
        if (HAS_LOGO) doc.image(LOGO_PATH, LOGO_X, LOGO_Y, { height: LOGO_H, fit: [LOGO_W, LOGO_H] });

        const CO_TX  = LOGO_X + LOGO_W + 4 * MM; // always 4mm after logo, even if no logo
        const CO_MAX = PW - PM - 70 * MM;         // don't overlap "QUOTATION" title

        doc.font('Helvetica-Bold').fontSize(9).fillColor(DKROW)
           .text('CANVAS GUY LIMITED', CO_TX, LOGO_Y + 0.5 * MM, { width: CO_MAX, lineBreak: false });
        doc.font('Helvetica').fontSize(6.5).fillColor('#888888')
           .text('holla@canvasguy.co.ke  ·  Ruiru, Kiambu County  ·  0713 196 650',
             CO_TX, LOGO_Y + 5 * MM, { width: CO_MAX, lineBreak: false });

        // "QUOTATION" — top-right, fixed position
        doc.font('Helvetica-Bold').fontSize(20).fillColor(DKROW)
           .text('QUOTATION', PM, LOGO_Y, { align: 'right', width: PCW, lineBreak: false });

        // ── 2. DARK BAND ────────────────────────────────────────────────────────
        const HDR_TOP = LOGO_Y + LOGO_H + 2 * MM;
        fillRect(doc, 0, HDR_TOP, PW, 8 * MM, DKROW);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE)
           .text(quote.quote_num || 'QUOTATION', PM, HDR_TOP + 2.2 * MM, { lineBreak: false });
        const bandRight = [
          quote.valid_until ? `Valid Until: ${fmtDate(quote.valid_until)}` : null,
          `Issued: ${fmtDate(quote.created_at)}`,
        ].filter(Boolean).join('  ·  ');
        doc.font('Helvetica').fontSize(7).fillColor('#CCCCCC')
           .text(bandRight, PM, HDR_TOP + 2.6 * MM, { align: 'right', width: PCW, lineBreak: false });

        // ── 3. TWO-COLUMN META — Bill To (left) + Quote Details (right) ────────
        let y  = HDR_TOP + 8 * MM + 5 * MM;
        let ry = y;

        // Left: BILL TO
        fillRect(doc, COL_L, y, ACCENT_W, 3.5 * MM, CORAL);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(CORAL)
           .text('BILL TO', COL_L + ACCENT_W + 2, y + 0.5 * MM, { lineBreak: false });
        y += 5 * MM;
        doc.font('Helvetica-Bold').fontSize(13).fillColor(DKROW)
           .text(clientName, COL_L, y, { width: COL_W, lineBreak: false });
        y += 9 * MM;
        const billLines = [clientContact, clientPhone, clientAddress].filter(Boolean);
        for (const line of billLines) {
          doc.font('Helvetica').fontSize(8).fillColor(DGRAY)
             .text(line, COL_L, y, { width: COL_W, lineBreak: false });
          y += 5.5 * MM;
        }

        // Right: QUOTE DETAILS
        fillRect(doc, COL_R, ry, ACCENT_W, 3.5 * MM, CORAL);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(CORAL)
           .text('QUOTE DETAILS', COL_R + ACCENT_W + 2, ry + 0.5 * MM, { lineBreak: false });
        ry += 6 * MM;
        const detailRows = [];
        if (quote.project_description) detailRows.push(['PROJECT', quote.project_description]);
        detailRows.push(['PAYMENT TERMS', TERMS_LABELS[quote.payment_terms] || quote.payment_terms || '—']);
        detailRows.push(['PRICING', quote.pricing_mode === 'vat_inclusive' ? 'VAT Inclusive' : 'VAT Exclusive']);
        for (const [label, val] of detailRows) {
          doc.font('Helvetica').fontSize(6.5).fillColor('#999999')
             .text(label, COL_R + ACCENT_W + 2, ry, { lineBreak: false });
          ry += 4 * MM;
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DKROW)
             .text(val, COL_R + ACCENT_W + 2, ry, { width: COL_W - ACCENT_W - 2, lineBreak: false });
          ry += 7 * MM;
        }

        // Advance y past both columns, tight gap before table
        y = Math.max(y, ry) + 4 * MM;

        // ── 4. LINE ITEMS TABLE ─────────────────────────────────────────────────
        // Section accent
        fillRect(doc, COL_L, y, ACCENT_W, 3.5 * MM, CORAL);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(CORAL)
           .text('LINE ITEMS', COL_L + ACCENT_W + 2, y + 0.5 * MM, { lineBreak: false });
        y += 5 * MM;

        y = ensureSpace(y, QT_HDR_H, false);
        y = qtDrawHeader(y);

        for (let i = 0; i < productItems.length; i++) {
          const item = productItems[i];
          const desc = item.description || '—';
          doc.font('Helvetica').fontSize(8);
          const specParts = [item.size, item.finish_type, item.finish_color, item.wood_type].filter(Boolean);
          const specStr   = specParts.join(' · ');
          doc.font('Helvetica').fontSize(6.5);
          const estH = Math.max(QT_MIN_ROW,
            doc.heightOfString(desc, { width: W_DESC }) +
            (specStr ? doc.heightOfString(specStr, { width: W_DESC }) + 1.5 * MM : 0) + 6 * MM);
          y = ensureSpace(y, estH, true);
          y = qtDrawRow(y, item, i);
        }

        // Additional charges
        if (additionalItems.length > 0) {
          y += 3 * MM;
          y = ensureSpace(y, 5.5 * MM + QT_HDR_H, false);
          fillRect(doc, COL_L, y, ACCENT_W, 3.5 * MM, CORAL);
          doc.font('Helvetica-Bold').fontSize(7).fillColor(CORAL)
             .text('ADDITIONAL CHARGES', COL_L + ACCENT_W + 2, y + 0.5 * MM, { lineBreak: false });
          y += 5 * MM;
          y = qtDrawHeader(y);
          for (let i = 0; i < additionalItems.length; i++) {
            const it = additionalItems[i];
            const catLabel = CHARGE_LABELS[it.line_type] || it.line_type || '';
            const estH = Math.max(QT_MIN_ROW,
              doc.heightOfString(it.description || '—', { width: W_DESC }) + 6 * MM);
            y = ensureSpace(y, estH, true);
            y = qtDrawRow(y, it, i, catLabel);
          }
        }

        // ── 5. TOTALS BLOCK ─────────────────────────────────────────────────────
        // Fixed two-column block: label left, amount right, inside a fixed-width panel
        const TOT_BLOCK_W = 80 * MM;
        const TOT_BLOCK_X = T_RIGHT - TOT_BLOCK_W;
        const TOT_ROW_H   = 6.5 * MM;
        const TOT_LBL_MAX = 45 * MM;

        // Calculate totals rows
        // Derive product-only subtotal and VAT from the actual line items (not the quote header,
        // which now stores the full grand total including charges).
        const itemsSubtotal = productItems.reduce((s, it) => s + parseFloat(it.net_amount   || 0), 0);
        const vatAmount     = productItems.reduce((s, it) => s + parseFloat(it.vat_amount   || 0), 0);
        const addlTotal     = additionalItems.reduce((s, it) => s + parseFloat(it.gross_amount || 0), 0);
        const grandTotal    = parseFloat(quote.total || 0); // now stored as true grand total incl. charges

        const totRows = [];
        if (additionalItems.length > 0) {
          totRows.push({ label: 'Items subtotal',      amount: itemsSubtotal, muted: true });
          totRows.push({ label: 'Additional charges',  amount: addlTotal,     muted: true });
        } else {
          totRows.push({ label: 'Items subtotal',      amount: itemsSubtotal, muted: true });
        }
        if (vatAmount > 0) {
          totRows.push({ label: 'VAT (16%)',           amount: vatAmount,     muted: true });
        }
        totRows.push({ label: 'Grand total',           amount: grandTotal,    grand: true });

        const totBlockH = totRows.length * TOT_ROW_H + 2 * MM;
        y += 4 * MM;
        y = ensureSpace(y, totBlockH + 2 * MM, false);

        // Thin top rule
        doc.save().moveTo(TOT_BLOCK_X, y).lineTo(T_RIGHT, y)
           .lineWidth(0.5).strokeColor('#DDDDDD').stroke().restore();
        y += 2 * MM;

        for (const row of totRows) {
          if (row.grand) {
            // Coral grand total bar
            fillRect(doc, TOT_BLOCK_X, y, TOT_BLOCK_W, TOT_ROW_H, CORAL);
            doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE)
               .text('GRAND TOTAL', TOT_BLOCK_X + 2 * MM, y + 1.8 * MM, { lineBreak: false });
            doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE)
               .text(`KES ${fmtKes(row.amount)}`, TOT_BLOCK_X, y + 1.8 * MM,
                 { align: 'right', width: TOT_BLOCK_W - 2 * MM, lineBreak: false });
          } else {
            // Neutral row
            doc.font('Helvetica').fontSize(8).fillColor('#666666')
               .text(row.label, TOT_BLOCK_X + 2 * MM, y + 1.5 * MM, { lineBreak: false });
            doc.font('Helvetica').fontSize(8).fillColor(DGRAY)
               .text(`KES ${fmtKes(row.amount)}`, TOT_BLOCK_X, y + 1.5 * MM,
                 { align: 'right', width: TOT_BLOCK_W - 2 * MM, lineBreak: false });
            // Bottom divider
            doc.save().moveTo(TOT_BLOCK_X, y + TOT_ROW_H - 0.5).lineTo(T_RIGHT, y + TOT_ROW_H - 0.5)
               .lineWidth(0.3).strokeColor('#EEEEEE').stroke().restore();
          }
          y += TOT_ROW_H;
        }

        // ── 6. SIGNATURE BLOCK ──────────────────────────────────────────────────
        y += 8 * MM;
        const SIG_LABELS = ['PREPARED BY (CANVAS GUY)', 'AUTHORISED BY (CLIENT)'];
        const SIG_COL_W  = PCW / SIG_LABELS.length;
        const SIG_NEEDED = 20 * MM;
        y = ensureSpace(y, SIG_NEEDED, false);

        SIG_LABELS.forEach((label, i) => {
          const sx   = PM + i * SIG_COL_W;
          const lineY = y + 11 * MM;
          doc.font('Helvetica').fontSize(7).fillColor('#999999')
             .text(label, sx, y, { lineBreak: false });
          doc.save().moveTo(sx, lineY).lineTo(sx + SIG_COL_W - 6 * MM, lineY)
             .lineWidth(0.5).dash(2, { space: 2 }).strokeColor('#AAAAAA').stroke().restore();
          doc.font('Helvetica').fontSize(6.5).fillColor('#BBBBBB')
             .text('Name & Date', sx, lineY + 2 * MM, { lineBreak: false });
        });

        // ── 7. FOOTER ───────────────────────────────────────────────────────────
        fillRect(doc, 0, PH - FOOTER_H, PW, FOOTER_H, '#F0F0F0');
        doc.font('Helvetica').fontSize(6.5).fillColor('#999999')
           .text('Canvas Guy Limited  ·  Ruiru, Kiambu County, Kenya', PM, PH - 7 * MM, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#999999')
           .text(quote.quote_num || '', PM, PH - 7 * MM,
             { align: 'right', width: PCW, lineBreak: false });

        doc.end();
        return;
      }

      // ── Orders report (production / financial) ────────────────────────────
      const orders   = data.orders    || [];
      const allItems = data.allItems  || {};
      const payTotals = data.payTotals || {};
      const showFin  = !!data.showFinancials;
      const workload = data.workloadSummary || [];

      const rows = [];
      let totalUnits = 0;

      orders.forEach(order => {
        const oid   = order.id || '';
        const items = allItems[oid] || [];
        const paid  = parseFloat(payTotals[oid] || 0);
        const tv    = parseFloat(order.total_value || 0);
        const bal   = Math.max(tv - paid, 0);

        if (showFin) {
          rows.push({
            client:    order.client    || '',
            order_num: order.order_num || '',
            due_date:  fmtDate(order.due_date),
            status:    order.status    || '',
            value:     fmtKes(tv),
            paid:      fmtKes(paid),
            balance:   fmtKes(bal),
          });
          totalUnits++;
        } else {
          if (!items.length) {
            rows.push({
              client: order.client || '', order_num: order.order_num || '',
              due_date: fmtDate(order.due_date), status: order.status || '',
              category: '—', description: order.items || '—',
              qty: '—', size: '—', finish: '—', wood: '—',
            });
            totalUnits++;
          } else {
            items.forEach((item, idx) => {
              const qty    = item.quantity || 1;
              totalUnits  += qty;
              const finish = [item.finish_type, item.finish_color].filter(Boolean).join(' / ') || '—';
              rows.push({
                client:      idx === 0 ? (order.client    || '') : '',
                order_num:   idx === 0 ? (order.order_num || '') : '',
                due_date:    idx === 0 ? fmtDate(order.due_date) : '',
                status:      idx === 0 ? (order.status    || '') : '',
                category:    item.category    || '—',
                description: item.description || '—',
                qty:         String(qty),
                size:        item.size        || '—',
                finish,
                wood:        item.wood_type   || '—',
              });
            });
          }
        }
      });

      const cols = showFin ? FIN_COLS : PROD_COLS;

      if (!data.payrollRun && !data.employeePayrollReport && data.invoicePdf == null && !data.crmInvoice) {
      doc = new PDFDocument({ size: [LW, LH], autoFirstPage: false, margin: 0 });
      doc.on('data', c => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let pageNum = 1;
      doc.addPage();
      let y = drawLandscapeHeader(doc, `${reportLabel} Report`, subtitle, nowStr, userName, pageNum);
      if (workload.length) y = drawWorkloadCards(doc, y, workload);
      y = drawSectionBar(doc, y, 'ORDER DETAILS');
      y = drawColHeaders(doc, y, cols);

      rows.forEach((row, idx) => {
        if (y + ROW_H > LH - LBOTTOM) {
          doc.addPage(); pageNum++;
          y = drawLandscapeHeader(doc, `${reportLabel} Report`, subtitle, nowStr, userName, pageNum);
          y = drawSectionBar(doc, y, 'ORDER DETAILS (continued)');
          y = drawColHeaders(doc, y, cols);
        }
        y = drawDataRow(doc, y, cols, row, idx);
      });

      if (y + 10 * MM > LH - LBOTTOM) { doc.addPage(); pageNum++; y = drawLandscapeHeader(doc, `${reportLabel} Report`, subtitle, nowStr, userName, pageNum); }
      const nOrders = orders.length;
      const leftText = `TOTAL  |  ${nOrders} order${nOrders !== 1 ? 's' : ''}  |  ${totalUnits} units`;

      if (showFin) {
        const totalVal  = orders.reduce((s, o) => s + parseFloat(o.total_value || 0), 0);
        const totalPaid = orders.reduce((s, o) => s + parseFloat(payTotals[o.id || ''] || 0), 0);
        const totalBal  = Math.max(totalVal - totalPaid, 0);
        drawTotalsBar(doc, y + 2 * MM, leftText,
          `Value: KES ${fmtKes(totalVal)}   Collected: KES ${fmtKes(totalPaid)}   Outstanding: KES ${fmtKes(totalBal)}`);
      } else {
        drawTotalsBar(doc, y + 2 * MM, leftText);
      }

      doc.end();
      return;
      } // end orders-only guard

      // ── Invoice PDF (portrait A4, client-facing) ─────────────────────────────
      if (data.invoicePdf != null) {
        const order    = data.invoicePdf.order || {};
        const customer = order.customers || {};
        const items    = order.order_items || [];
        const payments = order.order_payments || [];

        const totalPaid = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
        const balance   = parseFloat(order.total_value || 0) - totalPaid;

        // Header
        fillRect(doc, 0, 0, PW, 28 * MM, CORAL);
        if (HAS_LOGO) doc.image(LOGO_PATH, PM, 4 * MM, { height: 20 * MM, fit: [55 * MM, 20 * MM] });
        doc.font('Helvetica-Bold').fontSize(18).fillColor(WHITE)
           .text('INVOICE', 0, 9 * MM, { align: 'center', lineBreak: false });
        doc.font('Helvetica').fontSize(8).fillColor(WHITE)
           .text(order.invoice_number || order.order_num || '', 0, 18 * MM, { align: 'center', lineBreak: false });

        let y = 32 * MM;
        const col1x = PM; const col2x = PW / 2 + 5 * MM;
        const billRows = [
          ['Bill To:',    customer.name || order.client || '—'],
          ['Contact:',    customer.contact_person || order.contact_person || '—'],
          ['Phone:',      customer.phone || '—'],
          ['KRA PIN:',    customer.kra_pin || '—'],
        ];
        const refRows = [
          ['Invoice #:',  order.invoice_number || '—'],
          ['Order #:',    order.order_num || '—'],
          ['Date:',       fmtDate(order.invoice_issued_at || order.created_at)],
          ['Due Date:',   fmtDate(order.payment_due_date)],
        ];
        for (let i = 0; i < billRows.length; i++) {
          const ry = y + i * 5.5 * MM;
          doc.font('Helvetica-Bold').fontSize(7).fillColor(DGRAY).text(billRows[i][0], col1x, ry, { lineBreak: false });
          doc.font('Helvetica').fontSize(7).fillColor(DGRAY).text(billRows[i][1], col1x + 22 * MM, ry, { lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(7).fillColor(DGRAY).text(refRows[i][0], col2x, ry, { lineBreak: false });
          doc.font('Helvetica').fontSize(7).fillColor(DGRAY).text(refRows[i][1], col2x + 28 * MM, ry, { lineBreak: false });
        }
        y += 30 * MM;

        // Items table — same columns as quotation
        const INV_COLS = [
          { label: '#',           x: PM,              w: 8  * MM, centre: true },
          { label: 'Description', x: PM + 8 * MM,    w: 70 * MM },
          { label: 'Type',        x: PM + 78 * MM,   w: 18 * MM },
          { label: 'Qty',         x: PM + 96 * MM,   w: 12 * MM, right: true },
          { label: 'Unit Price',  x: PM + 108 * MM,  w: 26 * MM, right: true },
          { label: 'Net',         x: PM + 134 * MM,  w: 24 * MM, right: true },
          { label: 'VAT',         x: PM + 158 * MM,  w: 22 * MM, right: true },
          { label: 'Gross (KES)', x: PM + 180 * MM,  w: PCW - 180 * MM, right: true },
        ];

        fillRect(doc, PM, y, PCW, HDR_H, DKROW);
        for (const col of INV_COLS) {
          const opts = { font: 'Helvetica-Bold', size: 6.5, color: WHITE };
          if (col.centre) drawCenter(doc, col.label, col.x + col.w / 2, y + 1.8 * MM, opts);
          else if (col.right) drawRight(doc, col.label, col.x + col.w, y + 1.8 * MM, opts);
          else drawLeft(doc, col.label, col.x, y + 1.8 * MM, opts);
        }
        y += HDR_H;

        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx];
          const specParts = [
            item.category,
            item.size,
            item.finish_type && item.finish_type !== 'None' ? item.finish_type : null,
            item.finish_color,
            item.wood_type,
          ].filter(Boolean);
          const specLine  = specParts.join('  ·  ');
          const hasSpec   = specLine.length > 0;
          const rowH      = hasSpec ? ROW_H + 4.5 * MM : ROW_H;
          const bg        = idx % 2 === 0 ? WHITE : LGRAY;

          fillRect(doc, PM, y, PCW, rowH, bg);

          // Main line
          drawCenter(doc, idx + 1, PM + 4 * MM, y + 1.5 * MM);
          drawLeft(doc, item.description || '—', PM + 8 * MM, y + 1.5 * MM, { maxW: 70 * MM });
          drawLeft(doc, item.line_type || 'product', PM + 78 * MM, y + 1.5 * MM, { size: 6 });
          drawRight(doc, item.quantity,                                          PM + 108 * MM, y + 1.5 * MM);
          drawRight(doc, fmtKes(item.unit_price),                               PM + 134 * MM, y + 1.5 * MM);
          drawRight(doc, fmtKes(item.net_amount   ?? (item.quantity * item.unit_price)), PM + 158 * MM, y + 1.5 * MM);
          drawRight(doc, fmtKes(item.vat_amount),                               PM + 180 * MM, y + 1.5 * MM);
          drawRight(doc, fmtKes(item.gross_amount ?? item.unit_price * item.quantity),   PM + PCW,      y + 1.5 * MM, { font: 'Helvetica-Bold' });

          // Spec sub-line
          if (hasSpec) {
            doc.font('Helvetica').fontSize(6).fillColor('#999999')
               .text(specLine, PM + 8 * MM, y + ROW_H - 0.5 * MM, { lineBreak: false });
          }

          y += rowH;
        }

        // Totals
        y += 4 * MM;
        const totBox = PW - PM - 80 * MM;
        const totW   = 80 * MM;
        const trows = [
          [LGRAY, 7, 'Helvetica', 'Subtotal (excl. VAT)', fmtKes(order.subtotal_amount ?? (parseFloat(order.total_value || 0) - parseFloat(order.vat_amount || 0)))],
          [WHITE,  7, 'Helvetica', 'VAT (16%)',            fmtKes(order.vat_amount)],
        ];
        for (const [bg, sz, fnt, label, val] of trows) {
          fillRect(doc, totBox, y, totW, 5 * MM, bg);
          doc.font(fnt).fontSize(sz).fillColor(DGRAY)
             .text(label, totBox + 2 * MM, y + 1.2 * MM, { lineBreak: false });
          const vw = doc.widthOfString(`KES ${val}`);
          doc.text(`KES ${val}`, totBox + totW - vw - 2 * MM, y + 1.2 * MM, { lineBreak: false });
          y += 5 * MM;
        }
        fillRect(doc, totBox, y, totW, 7 * MM, CORAL);
        drawLeft(doc, 'TOTAL DUE', totBox + 2 * MM, y + 1.8 * MM, { size: 9, font: 'Helvetica-Bold', color: WHITE });
        drawRight(doc, `KES ${fmtKes(order.total_value)}`, totBox + totW, y + 1.8 * MM, { size: 9, font: 'Helvetica-Bold', color: WHITE });
        y += 9 * MM;

        // Payments received
        if (payments.length > 0) {
          y += 4 * MM;
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DGRAY).text('Payments Received', PM, y, { lineBreak: false });
          y += 5 * MM;
          for (const p of payments) {
            fillRect(doc, PM, y, PCW, 5.5 * MM, LGRAY);
            drawLeft(doc, fmtDate(p.payment_date), PM, y + 1.2 * MM, { size: 6.5 });
            drawLeft(doc, p.description || 'Payment', PM + 30 * MM, y + 1.2 * MM, { size: 6.5 });
            drawRight(doc, `KES ${fmtKes(p.amount)}`, PM + PCW, y + 1.2 * MM, { size: 6.5, font: 'Helvetica-Bold' });
            y += 5.5 * MM;
          }
          y += 3 * MM;
          fillRect(doc, totBox, y, totW, 6 * MM, balance > 0 ? '#FFF3E0' : '#E8F5E9');
          const balColor = balance > 0 ? '#E65100' : '#2E7D32';
          drawLeft(doc, balance > 0 ? 'BALANCE DUE' : 'PAID IN FULL', totBox + 2 * MM, y + 1.5 * MM,
            { size: 8, font: 'Helvetica-Bold', color: balColor });
          drawRight(doc, `KES ${fmtKes(Math.abs(balance))}`, totBox + totW, y + 1.5 * MM,
            { size: 8, font: 'Helvetica-Bold', color: balColor });
        }

        // Payment details box
        y += 14 * MM;
        fillRect(doc, PM, y, PCW, 3 * MM, MGRAY);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(DGRAY)
           .text('Payment Details', PM + 2 * MM, y + 0.5 * MM, { lineBreak: false });
        y += 5 * MM;
        const payDetails = [
          'Bank: ABSA Bank Kenya | Account: Canvas Guy Limited | A/C: 2048527698',
          'M-PESA Paybill: 303030 | Account No: Use Invoice Number as reference',
        ];
        for (const line of payDetails) {
          doc.font('Helvetica').fontSize(7).fillColor(DGRAY).text(line, PM, y, { lineBreak: false });
          y += 5 * MM;
        }

        // Footer
        fillRect(doc, 0, PH - PBOTTOM, PW, PBOTTOM, DKROW);
        drawCenter(doc, 'Canvas Guy Limited  |  Thank you for your business', PW / 2, PH - PBOTTOM + 5 * MM,
          { size: 7, color: WHITE, font: 'Helvetica-Bold' });

        doc.end();
        return;
      }

      // ════════════════════════════════════════════════════════════════════════
      // CRM INVOICE PDF  (portrait A4, 6 sections, paginated)
      // data.crmInvoice = { invoice, vatBreakdown, quoteHistory,
      //                     trackerProgress, deliveryHistory, paymentHistory }
      // ════════════════════════════════════════════════════════════════════════
      if (data.crmInvoice) {
        const { invoice = {}, vatBreakdown, quoteHistory = [], trackerProgress = [],
                deliveryHistory = [], paymentHistory = [] } = data.crmInvoice;
        const customer = invoice.customer || {};
        const items    = vatBreakdown?.items || [];

        // ── Colours ───────────────────────────────────────────────────────────
        const NAVY  = '#1A2E4A';
        const GREEN = '#2E7D32';
        const RED   = '#C62828';
        const LNAVY = '#EAF0F8';

        const portDoc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
        const bufs = [];
        portDoc.on('data', c => bufs.push(c));
        portDoc.on('end',  () => resolve(Buffer.concat(bufs)));
        portDoc.on('error', reject);

        // ── Layout constants ──────────────────────────────────────────────────
        const pPM  = 14 * MM;
        const pPW  = 210 * MM;
        const pPH  = 297 * MM;
        const pCW  = pPW - pPM * 2;
        const FOOTER_H = 8 * MM;
        const SAFE = pPH - FOOTER_H - 8 * MM;

        // ── Drawing helpers ───────────────────────────────────────────────────
        function pFill(x, y, w, h, color) { portDoc.rect(x, y, w, h).fill(color); }
        function pStroke(x, y, w, h, color, lw = 0.5) {
          portDoc.rect(x, y, w, h).lineWidth(lw).strokeColor(color).stroke();
        }
        function pLine(x1, y1, x2, y2, color, lw = 0.5) {
          portDoc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(lw).strokeColor(color).stroke();
        }
        function pText(text, x, y, opts = {}) {
          const { font = 'Helvetica', size = 7, color = DGRAY, maxW } = opts;
          portDoc.font(font).fontSize(size).fillColor(color)
                 .text(String(text ?? ''), x, y, { lineBreak: false, ...(maxW ? { width: maxW } : {}) });
        }
        function pLeft(text, x, y, opts = {})  { pText(text, x, y, opts); }
        function pRight(text, rx, y, opts = {}) {
          const s = String(text ?? '');
          portDoc.font(opts.font || 'Helvetica').fontSize(opts.size || 7);
          const w = portDoc.widthOfString(s);
          pText(s, rx - w, y, opts);
        }
        function pCenter(text, cx, y, opts = {}) {
          const s = String(text ?? '');
          portDoc.font(opts.font || 'Helvetica').fontSize(opts.size || 7);
          const w = portDoc.widthOfString(s);
          pText(s, cx - w / 2, y, opts);
        }

        // Format raw DB payment terms to readable label
        function fmtTerms(t) {
          if (!t) return '—';
          return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }

        // Small coral vertical accent used on section headings
        function coralAccent(x, y, h = 4.5 * MM) { pFill(x, y, 2.5, h, CORAL); }

        // Section heading with coral accent — returns new y
        function secHeading(label, y) {
          coralAccent(pPM, y);
          pLeft(label, pPM + 4 * MM, y + 0.8 * MM, { font: 'Helvetica-Bold', size: 8, color: NAVY });
          return y + 6 * MM;
        }

        // Navy table header bar — returns new y
        function navyHdr(y, drawFn, h = 5.5 * MM) {
          pFill(pPM, y, pCW, h, NAVY);
          drawFn(y + 1.2 * MM);
          return y + h;
        }

        // Page-break guard
        function guard(y, needed) {
          if (y + needed > SAFE) {
            drawFooter();
            portDoc.addPage();
            return pPM;
          }
          return y;
        }

        // Thin coral line footer
        function drawFooter() {
          pLine(pPM, pPH - FOOTER_H, pPM + pCW, pPH - FOOTER_H, CORAL, 1);
          pLeft('Canvas Guy Limited  |  Ruiru, Kiambu County, Kenya',
            pPM, pPH - FOOTER_H + 2 * MM, { size: 6, color: '#777777' });
          pRight(invoice.invoice_number || invoice.order_num || '',
            pPM + pCW, pPH - FOOTER_H + 2 * MM, { size: 6, color: '#777777' });
        }

        // ══════════════════════════════════════════════════════════════════════
        // PAGE 1 — HEADER
        // White logo block (left) + coral company strip (right of logo)
        // ══════════════════════════════════════════════════════════════════════
        const HDR_H = 26 * MM;
        const LOGO_W = 52 * MM;

        // White background for the whole header area
        pFill(0, 0, pPW, HDR_H, WHITE);
        // Coral strip from logo edge to right
        pFill(LOGO_W + pPM, 0, pPW - LOGO_W - pPM, HDR_H, CORAL);

        // Logo
        if (HAS_LOGO) portDoc.image(LOGO_PATH, pPM, 3 * MM, { height: 20 * MM, fit: [LOGO_W, 20 * MM] });

        // Company name & tagline inside coral strip
        const coralX = LOGO_W + pPM + 4 * MM;
        pLeft('CANVAS GUY LIMITED', coralX, 5 * MM, { font: 'Helvetica-Bold', size: 14, color: WHITE });
        pLeft('Furniture & Interiors', coralX, 13 * MM, { size: 8, color: 'rgba(255,255,255,0.85)' });

        // INVOICE label + number — top right
        pRight('INVOICE', pPM + pCW, 5 * MM, { font: 'Helvetica-Bold', size: 18, color: WHITE });
        pRight(invoice.invoice_number || 'PENDING', pPM + pCW, 16.5 * MM,
          { font: 'Helvetica-Bold', size: 9, color: WHITE });

        // ── Navy info bar ─────────────────────────────────────────────────────
        const INFO_Y = HDR_H;
        const INFO_H = 8 * MM;
        pFill(0, INFO_Y, pPW, INFO_H, NAVY);
        const infoItems = [
          { label: 'INVOICE #', value: invoice.invoice_number || '—' },
          { label: 'ORDER #',   value: invoice.order_num || '—' },
          { label: 'DATE',      value: fmtDate(invoice.invoice_issued_at) },
          { label: 'DUE DATE',  value: fmtDate(invoice.payment_due_date) },
        ];
        const infoSlotW = pCW / infoItems.length;
        for (let i = 0; i < infoItems.length; i++) {
          const ix = pPM + i * infoSlotW;
          // Divider between slots
          if (i > 0) {
            portDoc.moveTo(pPM + i * infoSlotW - 0.5, INFO_Y + 1.5 * MM)
                   .lineTo(pPM + i * infoSlotW - 0.5, INFO_Y + INFO_H - 1.5 * MM)
                   .lineWidth(0.3).strokeColor('rgba(255,255,255,0.2)').stroke();
          }
          pLeft(infoItems[i].label, ix + 2 * MM, INFO_Y + 1.5 * MM,
            { size: 5.5, color: 'rgba(255,255,255,0.55)', font: 'Helvetica-Bold' });
          pLeft(infoItems[i].value, ix + 2 * MM, INFO_Y + 4.2 * MM,
            { size: 7.5, color: WHITE, font: 'Helvetica-Bold' });
        }

        let y = INFO_Y + INFO_H + 8 * MM;

        // ══════════════════════════════════════════════════════════════════════
        // CUSTOMER INFO — two-column: BILL TO (left) | INVOICE DETAILS (right)
        // ══════════════════════════════════════════════════════════════════════
        const COL2X = pPM + pCW / 2 + 4 * MM;
        const COL2W = pCW / 2 - 4 * MM;

        // Left — BILL TO
        coralAccent(pPM, y);
        pLeft('BILL TO', pPM + 4 * MM, y + 0.8 * MM, { font: 'Helvetica-Bold', size: 7.5, color: NAVY });
        y += 6 * MM;
        const billLines = [
          [customer.name || invoice.client || '—', true],
          [customer.contact_person || invoice.contact_person || null, false],
          [customer.phone || null, false],
          [customer.kra_pin ? `KRA PIN: ${customer.kra_pin}` : null, false],
        ];
        let billY = y;
        for (const [val, bold] of billLines) {
          if (!val) continue;
          pLeft(val, pPM, billY, { size: bold ? 8.5 : 7, font: bold ? 'Helvetica-Bold' : 'Helvetica', color: DGRAY });
          billY += bold ? 5.5 * MM : 4.5 * MM;
        }

        // Right — INVOICE DETAILS
        const detailStartY = y - 6 * MM;
        coralAccent(COL2X, detailStartY);
        pLeft('INVOICE DETAILS', COL2X + 4 * MM, detailStartY + 0.8 * MM, { font: 'Helvetica-Bold', size: 7.5, color: NAVY });
        const detailRows = [
          ['Quote',       `${invoice.quote_num || '—'}${invoice.quote_revision != null ? ` R${invoice.quote_revision}` : ''}`],
          ['Order',       invoice.order_num || '—'],
          ['Terms',       fmtTerms(invoice.payment_terms)],
          ['VAT Mode',    vatBreakdown?.pricing_mode === 'vat_exclusive' ? 'VAT Exclusive'
                        : vatBreakdown?.pricing_mode === 'vat_inclusive' ? 'VAT Inclusive' : 'No VAT'],
          ['Due Date',    fmtDate(invoice.payment_due_date)],
        ];
        let detailY = detailStartY + 6 * MM;
        const LBL_W = 22 * MM;
        for (const [lbl, val] of detailRows) {
          pLeft(lbl, COL2X, detailY, { size: 6.5, color: '#777777' });
          pLeft(val, COL2X + LBL_W, detailY, { size: 7, font: 'Helvetica-Bold', color: DGRAY });
          detailY += 5 * MM;
        }

        y = Math.max(billY, detailY) + 6 * MM;
        pLine(pPM, y - 3 * MM, pPM + pCW, y - 3 * MM, MGRAY);

        // ══════════════════════════════════════════════════════════════════════
        // INVOICE ITEMS TABLE
        // ══════════════════════════════════════════════════════════════════════
        y = guard(y, 14 * MM);
        y = secHeading('Invoice Items', y);
        y += 2 * MM;

        // Column positions (mm from left margin)
        const IC = {
          num:   { cx: pPM + 4.5 * MM },
          desc:  { x:  pPM + 9 * MM,   maxW: 68 * MM },
          qty:   { rx: pPM + 98 * MM },
          unit:  { rx: pPM + 120 * MM },
          net:   { rx: pPM + 141 * MM },
          vat:   { rx: pPM + 158 * MM },
          gross: { rx: pPM + pCW },
        };

        function ITEM_HDR(hy) {
          return navyHdr(hy, (ty) => {
            pCenter('#',            IC.num.cx,   ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
            pLeft('Description',   IC.desc.x,   ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
            pRight('Qty',          IC.qty.rx,   ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
            pRight('Unit Price',   IC.unit.rx,  ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
            pRight('Net',          IC.net.rx,   ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
            pRight('VAT',          IC.vat.rx,   ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
            pRight('Gross (KES)',  IC.gross.rx, ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
          });
        }

        y = ITEM_HDR(y);

        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx];
          const spec = [
            item.finish_type && item.finish_type !== 'None' ? item.finish_type : null,
            item.finish_color,
            item.wood_type,
          ].filter(Boolean).join('  ·  ');
          const rowH = spec ? 10 * MM : 6 * MM;
          y = guard(y, rowH);
          if (y === pPM) y = ITEM_HDR(y);
          pFill(pPM, y, pCW, rowH, idx % 2 === 0 ? WHITE : LGRAY);
          pCenter(idx + 1,                       IC.num.cx,   y + 1.5 * MM, { size: 7 });
          pLeft(item.description || '—',         IC.desc.x,   y + 1.5 * MM, { size: 7, maxW: IC.desc.maxW });
          pRight(String(item.quantity ?? '—'),    IC.qty.rx,   y + 1.5 * MM, { size: 7 });
          pRight(`KES ${fmtKes(item.unit_price)}`,IC.unit.rx, y + 1.5 * MM, { size: 7 });
          pRight(`KES ${fmtKes(item.net_amount)}`,IC.net.rx,  y + 1.5 * MM, { size: 7 });
          pRight(`KES ${fmtKes(item.vat_amount)}`,IC.vat.rx,  y + 1.5 * MM, { size: 7 });
          pRight(`KES ${fmtKes(item.gross_amount)}`,IC.gross.rx,y+1.5*MM,   { size: 7.5, font: 'Helvetica-Bold' });
          if (spec) {
            portDoc.font('Helvetica').fontSize(6).fillColor('#999999')
                   .text(spec, IC.desc.x, y + 6 * MM, { lineBreak: false });
          }
          y += rowH;
        }
        y += 2 * MM;

        // ══════════════════════════════════════════════════════════════════════
        // FINANCIAL SUMMARY — three cards: Total (navy) | Paid (green) | Balance (coral)
        // ══════════════════════════════════════════════════════════════════════
        y = guard(y + 3 * MM, 36 * MM);

        // Subtotal / VAT rows (right-aligned, narrow)
        if (vatBreakdown) {
          const totBox = pPM + pCW - 75 * MM;
          const totW   = 75 * MM;
          const vatPct = vatBreakdown.pricing_mode === 'none' ? '0%' : '16%';
          for (const [bg, lbl, val] of [
            [LGRAY, 'Subtotal (excl. VAT)', fmtKes(vatBreakdown.subtotal)],
            [WHITE, `VAT ${vatPct}`,         fmtKes(vatBreakdown.vat_amount)],
          ]) {
            pFill(totBox, y, totW, 5.5 * MM, bg);
            pLeft(lbl,             totBox + 3 * MM, y + 1.3 * MM, { size: 7 });
            pRight(`KES ${val}`, totBox + totW,   y + 1.3 * MM, { size: 7 });
            y += 5.5 * MM;
          }
          y += 3 * MM;
        }

        // Three financial cards
        const CARD_GAP = 3 * MM;
        const CARD_H   = 17 * MM;
        const CARD_W   = (pCW - 2 * CARD_GAP) / 3;

        const cards = [
          { label: 'Invoice Total', value: `KES ${fmtKes(invoice.total_value)}`,               bg: NAVY,  tx: WHITE },
          { label: 'Amount Paid',   value: `KES ${fmtKes(invoice.total_paid ?? 0)}`,            bg: GREEN, tx: WHITE },
          { label: 'Balance Due',   value: `KES ${fmtKes(Math.max(0, invoice.balance ?? 0))}`,  bg: CORAL, tx: WHITE },
        ];
        for (let i = 0; i < 3; i++) {
          const cx = pPM + i * (CARD_W + CARD_GAP);
          const { label, value, bg, tx } = cards[i];
          pFill(cx, y, CARD_W, CARD_H, bg);
          // Subtle top stripe for depth
          pFill(cx, y, CARD_W, 1.5, 'rgba(255,255,255,0.12)');
          // Label — upper area of card
          pCenter(label, cx + CARD_W / 2, y + 3 * MM,
            { size: 6.5, color: 'rgba(255,255,255,0.7)', font: 'Helvetica-Bold' });
          // Value — lower area, larger for Balance Due
          pCenter(value, cx + CARD_W / 2, y + 9 * MM,
            { size: i === 2 ? 12 : 10.5, color: tx, font: 'Helvetica-Bold' });
        }
        y += CARD_H + 8 * MM;

        // ══════════════════════════════════════════════════════════════════════
        // PAYMENT HISTORY
        // ══════════════════════════════════════════════════════════════════════
        if (paymentHistory.length > 0) {
          y = guard(y, 20 * MM);
          y = secHeading('Payment History', y);
          y += 2 * MM;

          function PMT_HDR(py) {
            return navyHdr(py, (ty) => {
              pLeft('Date',        pPM + 1 * MM,         ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pLeft('Reference',   pPM + 25 * MM,        ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pRight('Amount Paid',pPM + pCW - 35 * MM,  ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pRight('Running Balance', pPM + pCW,       ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
            });
          }
          y = PMT_HDR(y);

          for (const [idx, p] of paymentHistory.entries()) {
            y = guard(y, 6 * MM);
            if (y === pPM) y = PMT_HDR(y);
            pFill(pPM, y, pCW, 6 * MM, idx % 2 === 0 ? WHITE : LGRAY);
            const dim = p.is_reversed ? '#AAAAAA' : DGRAY;
            pLeft(fmtDate(p.payment_date), pPM + 1 * MM, y + 1.5 * MM, { size: 7, color: dim });
            pLeft(
              (p.description || 'Payment') + (p.is_reversed ? '  [Reversed]' : ''),
              pPM + 25 * MM, y + 1.5 * MM,
              { size: 7, color: dim, maxW: pCW - 70 * MM }
            );
            pRight(
              `KES ${fmtKes(p.amount)}`,
              pPM + pCW - 35 * MM, y + 1.5 * MM,
              { size: 7, color: dim, font: p.is_reversed ? 'Helvetica' : 'Helvetica-Bold' }
            );
            if (!p.is_reversed && p.running_balance != null) {
              pRight(
                `KES ${fmtKes(p.running_balance)}`,
                pPM + pCW, y + 1.5 * MM,
                { size: 7, font: 'Helvetica-Bold', color: p.running_balance > 0.5 ? RED : GREEN }
              );
            }
            y += 6 * MM;
          }
          y += 6 * MM;
        }

        // ══════════════════════════════════════════════════════════════════════
        // PAYMENT INSTRUCTIONS — two cards: M-PESA (left) | Bank Transfer (right)
        // ══════════════════════════════════════════════════════════════════════
        const PI_NEEDED = 52 * MM;
        y = guard(y, PI_NEEDED);
        y = secHeading('Payment Instructions', y);
        y += 2 * MM;

        const PI_W = (pCW - 4 * MM) / 2;
        const PI_H = 44 * MM;
        const PI_R = pPM + PI_W + 4 * MM;

        // M-PESA card
        pFill(pPM, y, PI_W, PI_H, LNAVY);
        pStroke(pPM, y, PI_W, PI_H, NAVY, 0.5);
        pFill(pPM, y, PI_W, 6 * MM, NAVY);
        pCenter('M-PESA', pPM + PI_W / 2, y + 1.5 * MM, { font: 'Helvetica-Bold', size: 8, color: WHITE });
        const mpesaLines = [
          ['Paybill Number', '4079031'],
          ['Account Number', 'Customer Name'],
          ['Reference',      'Invoice Number / Project Name'],
        ];
        let piY = y + 8 * MM;
        for (const [lbl, val] of mpesaLines) {
          pLeft(lbl, pPM + 3 * MM, piY, { size: 6, color: '#555555' });
          pLeft(val, pPM + 3 * MM, piY + 3.5 * MM, { size: 7.5, font: 'Helvetica-Bold', color: NAVY });
          piY += 9 * MM;
        }

        // Bank Transfer card
        pFill(PI_R, y, PI_W, PI_H, LNAVY);
        pStroke(PI_R, y, PI_W, PI_H, NAVY, 0.5);
        pFill(PI_R, y, PI_W, 6 * MM, NAVY);
        pCenter('Bank Transfer', PI_R + PI_W / 2, y + 1.5 * MM, { font: 'Helvetica-Bold', size: 8, color: WHITE });
        const bankLines = [
          ['Bank',           'ABSA Bank Kenya — Thika Branch'],
          ['Account Name',   'Canvas Guy Limited'],
          ['Account Number', '2045216104'],
          ['Sort / SWIFT',   '031  |  BARCKEN'],
        ];
        let biY = y + 8 * MM;
        for (const [lbl, val] of bankLines) {
          pLeft(lbl, PI_R + 3 * MM, biY, { size: 6, color: '#555555' });
          pLeft(val, PI_R + 3 * MM, biY + 3.5 * MM, { size: 7.5, font: 'Helvetica-Bold', color: NAVY });
          biY += 9 * MM;
        }
        y += PI_H + 4 * MM;

        // Proof-of-payment note
        y = guard(y, 10 * MM);
        pFill(pPM, y, pCW, 9 * MM, '#FFF8F5');
        pLeft('Send proof of payment to holla@canvasguy.co.ke  |  Always quote the invoice number or order reference.',
          pPM + 3 * MM, y + 2 * MM, { size: 6.5, color: CORAL });
        pLeft('Payment enquiries: 0713 196650',
          pPM + 3 * MM, y + 5.5 * MM, { size: 6.5, color: '#777777' });
        y += 12 * MM;

        // ══════════════════════════════════════════════════════════════════════
        // PAGE 2 CONTENT — Tracker, Delivery History, Quote Revisions
        // (pushed to their own page if they don't fit cleanly on page 1)
        // ══════════════════════════════════════════════════════════════════════

        // ── Order Progress Tracker — horizontal strip ─────────────────────────
        // Each stage is a small pill; completed = coral fill, current = coral + bold,
        // future = light grey. Connecting line runs behind all pills.
        if (trackerProgress.length > 0) {
          const TRACKER_NEEDED = 22 * MM;
          y = guard(y, TRACKER_NEEDED);
          y = secHeading('Order Progress', y);
          y += 2 * MM;

          const N        = trackerProgress.length;
          const PILL_H   = 6 * MM;
          const PILL_W   = (pCW - (N - 1) * 1.5 * MM) / N;
          const LINE_Y   = y + PILL_H / 2;

          // Background connector line
          portDoc.moveTo(pPM, LINE_Y).lineTo(pPM + pCW, LINE_Y)
                 .lineWidth(1).strokeColor('#DDDDDD').stroke();

          for (let i = 0; i < N; i++) {
            const s    = trackerProgress[i];
            const done = !!s.reached_at;
            const curr = s.is_current;
            const px   = pPM + i * (PILL_W + 1.5 * MM);

            // Fill connector line up to this pill if done
            if (done && i > 0) {
              portDoc.moveTo(pPM, LINE_Y).lineTo(px + PILL_W / 2, LINE_Y)
                     .lineWidth(1).strokeColor(CORAL).stroke();
            }

            // Pill background
            const pillColor = curr ? CORAL : done ? '#F2C4B8' : '#EEEEEE';
            portDoc.roundedRect(px, y, PILL_W, PILL_H, 1.5 * MM).fill(pillColor);

            // Stage label inside pill
            const labelColor = curr ? WHITE : done ? '#8B3A27' : '#AAAAAA';
            const labelFont  = curr ? 'Helvetica-Bold' : 'Helvetica';
            // Truncate long stage names to fit pill
            let stageName = s.stage;
            portDoc.font(labelFont).fontSize(5.5);
            while (portDoc.widthOfString(stageName) > PILL_W - 3 * MM && stageName.length > 4) {
              stageName = stageName.slice(0, -2);
            }
            pCenter(stageName, px + PILL_W / 2, y + 1.5 * MM,
              { size: 5.5, font: labelFont, color: labelColor });

            // Date below pill for reached stages
            if (s.reached_at) {
              pCenter(fmtDate(s.reached_at), px + PILL_W / 2, y + PILL_H + 1 * MM,
                { size: 5, color: '#888888' });
            }
          }
          y += PILL_H + 8 * MM;
        }

        // ── Delivery History ──────────────────────────────────────────────────
        if (deliveryHistory.length > 0) {
          y = guard(y, 20 * MM);
          y = secHeading('Delivery History', y);
          y += 2 * MM;

          function DLV_HDR(py) {
            return navyHdr(py, (ty) => {
              pLeft('Batch / Event', pPM + 1 * MM,    ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pLeft('Date',          pPM + 45 * MM,   ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pLeft('Status',        pPM + 75 * MM,   ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pRight('Units',        pPM + 140 * MM,  ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pRight('Value (KES)',  pPM + pCW,       ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
            });
          }
          y = DLV_HDR(y);

          for (const batch of deliveryHistory) {
            y = guard(y, 6 * MM);
            const bLabel = batch.batch_number ? `Batch ${batch.batch_number}` : 'Delivery';
            const cancelled = !batch.counts_toward_progress;
            const rowBg = cancelled ? '#FFF8F5' : WHITE;
            pFill(pPM, y, pCW, 6 * MM, rowBg);
            pLeft(bLabel, pPM + 1 * MM, y + 1.5 * MM,
              { font: 'Helvetica-Bold', size: 7, color: cancelled ? '#999999' : NAVY });
            pLeft(fmtDate(batch.actual_delivery_date), pPM + 45 * MM, y + 1.5 * MM, { size: 7 });
            pLeft(cancelled ? 'Cancelled/Rejected' : batch.status || '—',
              pPM + 75 * MM, y + 1.5 * MM,
              { size: 7, color: cancelled ? CORAL : DGRAY });
            const deliveredUnits = (batch.items || []).reduce((s, i) => s + (i.quantity_delivered || 0), 0);
            pRight(String(deliveredUnits || '—'), pPM + 140 * MM, y + 1.5 * MM, { size: 7 });
            pRight(`KES ${fmtKes(batch.batch_value)}`, pPM + pCW, y + 1.5 * MM,
              { size: 7, font: 'Helvetica-Bold', color: cancelled ? '#999999' : DGRAY });
            y += 6 * MM;
          }
          y += 4 * MM;
        }

        // ── Quote Revision History ────────────────────────────────────────────
        if (quoteHistory.length > 1) {
          y = guard(y, 20 * MM);
          y = secHeading('Quotation Revision History', y);
          y += 2 * MM;

          function QH_HDR(py) {
            return navyHdr(py, (ty) => {
              pLeft('Quote #',     pPM + 1 * MM,  ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pLeft('Rev',         pPM + 40 * MM, ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pLeft('Status',      pPM + 55 * MM, ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pLeft('Date',        pPM + 90 * MM, ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
              pRight('Total (KES)',pPM + pCW,     ty, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
            });
          }
          y = QH_HDR(y);

          for (const [idx, rev] of quoteHistory.entries()) {
            y = guard(y, 5.5 * MM);
            if (y === pPM) y = QH_HDR(y);
            pFill(pPM, y, pCW, 5.5 * MM, idx % 2 === 0 ? WHITE : LGRAY);
            const active = !!rev.converted_order_id;
            pLeft(rev.quote_num || '—', pPM + 1 * MM, y + 1.2 * MM,
              { size: 7, font: active ? 'Helvetica-Bold' : 'Helvetica', color: active ? NAVY : DGRAY });
            pLeft(`v${rev.revision}`,   pPM + 40 * MM, y + 1.2 * MM, { size: 7 });
            pLeft(rev.status || '—',    pPM + 55 * MM, y + 1.2 * MM, { size: 7 });
            pLeft(fmtDate(rev.created_at), pPM + 90 * MM, y + 1.2 * MM, { size: 7 });
            pRight(`KES ${fmtKes(rev.total)}`, pPM + pCW, y + 1.2 * MM,
              { size: 7, font: 'Helvetica-Bold', color: active ? CORAL : DGRAY });
            y += 5.5 * MM;
          }
          y += 4 * MM;
        }

        // ── Footer on current page ────────────────────────────────────────────
        drawFooter();

        portDoc.end();
        return;
      }

      // ════════════════════════════════════════════════════════════════════════
      // PAYROLL RUN PDF  (landscape A4)
      // data.payrollRun = { run, entries, adjustments }
      // ════════════════════════════════════════════════════════════════════════
      if (data.payrollRun) {
        const { run, entries = [], adjustments = [] } = data.payrollRun;

        // Build adj lookup: entry_id → [adj, ...]
        const adjByEntry = {};
        for (const a of adjustments) {
          if (!adjByEntry[a.entry_id]) adjByEntry[a.entry_id] = [];
          adjByEntry[a.entry_id].push(a);
        }

        const doc2 = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, autoFirstPage: true });
        const bufs = [];
        doc2.on('data', c => bufs.push(c));
        doc2.on('end', () => resolve(Buffer.concat(bufs)));

        // ── Column layout (mm from left margin) ──────────────────────────────
        const cols = mmCols([
          { key: 'name',    label: 'Employee',     x: LM/MM,  w: 42 },
          { key: 'type',    label: 'Type',         x: LM/MM + 42,   w: 18 },
          { key: 'days',    label: 'Days',         x: LM/MM + 60,   w: 12 },
          { key: 'gross',   label: 'Gross (KES)',  x: LM/MM + 72,   w: 24 },
          { key: 'sha',     label: 'SHA',          x: LM/MM + 96,   w: 18 },
          { key: 'advance', label: 'Advance',      x: LM/MM + 114,  w: 18 },
          { key: 'damage',  label: 'Damage',       x: LM/MM + 132,  w: 18 },
          { key: 'other',   label: 'Other Ded.',   x: LM/MM + 150,  w: 18 },
          { key: 'total_d', label: 'Total Ded.',   x: LM/MM + 168,  w: 20 },
          { key: 'net',     label: 'Net Pay',      x: LM/MM + 188,  w: 24 },
          { key: 'paid',    label: 'Paid',         x: LM/MM + 212,  w: 20 },
          { key: 'balance', label: 'Balance',      x: LM/MM + 232,  w: 20 },
          { key: 'status',  label: 'Status',       x: LM/MM + 252,  w: 22 },
        ]);

        const typeLabel = { casual: 'Casual', permanent: 'Permanent', skilled_casual: 'Skilled', combined: 'Combined' };
        const statusColor = { paid: '#2E7D32', part_paid: '#E65100', unpaid: '#C62828' };

        function pageHeader(d) {
          // Coral bar
          fillRect(d, 0, 0, LW, 20 * MM, CORAL);
          if (HAS_LOGO) {
            try { d.image(LOGO_PATH, LM, 3 * MM, { height: 14 * MM }); } catch {}
          }
          d.font('Helvetica-Bold').fontSize(11).fillColor(WHITE)
           .text(`Payroll Run: ${run.run_num}`, LM + 40 * MM, 4 * MM, { lineBreak: false });
          d.font('Helvetica').fontSize(8).fillColor(WHITE)
           .text(`${typeLabel[run.run_type] || run.run_type}  ·  ${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}  ·  Status: ${run.status.toUpperCase()}`, LM + 40 * MM, 9.5 * MM, { lineBreak: false });
          d.font('Helvetica').fontSize(7).fillColor(WHITE)
           .text(`Generated: ${fmtDate(new Date().toISOString())}`, LW - LM - 60 * MM, 4 * MM, { lineBreak: false });

          // Column header row
          let hy = 22 * MM;
          fillRect(d, LM, hy, LCW, HDR_H, DKROW);
          for (const c of cols) {
            drawLeft(d, c.label, c.x, hy + 1.5 * MM, { font: 'Helvetica-Bold', size: 6, color: WHITE });
          }
          return hy + HDR_H;
        }

        let y = pageHeader(doc2);
        let rowIdx = 0;

        // Totals accumulators
        let tGross = 0, tSha = 0, tAdv = 0, tDmg = 0, tOth = 0, tDed = 0, tNet = 0, tPaid = 0, tBal = 0;

        for (const e of entries) {
          if (y + ROW_H > LH - LBOTTOM) {
            doc2.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
            y = pageHeader(doc2);
            rowIdx = 0;
          }
          const bg = rowIdx % 2 === 0 ? '#FFFFFF' : LGRAY;
          fillRect(doc2, LM, y, LCW, ROW_H, bg);

          const gross   = Number(e.gross_pay        || 0);
          const sha     = Number(e.sha_deduction     || 0);
          const advance = Number(e.advance_deduction || 0);
          const damage  = Number(e.damage_deduction  || 0);
          const other   = Number(e.other_deductions  || 0);
          const totalD  = Number(e.total_deductions  || 0);
          const net     = Number(e.net_pay           || 0);
          const paid    = Number(e.amount_paid       || 0);
          const balance = net - paid;

          tGross += gross; tSha += sha; tAdv += advance; tDmg += damage;
          tOth += other; tDed += totalD; tNet += net; tPaid += paid; tBal += balance;

          const row = {
            name:    e.snapshot_name || e.employees?.name || '—',
            type:    typeLabel[e.snapshot_type] || e.snapshot_type || '—',
            days:    String(e.days_worked ?? '—'),
            gross:   fmtKes(gross),
            sha:     sha > 0 ? fmtKes(sha) : '—',
            advance: advance > 0 ? fmtKes(advance) : '—',
            damage:  damage > 0 ? fmtKes(damage) : '—',
            other:   other > 0 ? fmtKes(other) : '—',
            total_d: totalD > 0 ? fmtKes(totalD) : '—',
            net:     fmtKes(net),
            paid:    fmtKes(paid),
            balance: fmtKes(Math.abs(balance)),
            status:  e.payment_status || '—',
          };

          for (const c of cols) {
            if (c.key === 'status') {
              const sc = statusColor[e.payment_status] || DGRAY;
              drawLeft(doc2, row.status.toUpperCase(), c.x, y + 1.5 * MM, { size: 5.5, font: 'Helvetica-Bold', color: sc, maxW: c.w });
            } else if (['gross','net','paid','balance','sha','advance','damage','other','total_d'].includes(c.key)) {
              drawRight(doc2, row[c.key], c.x + c.w, y + 1.5 * MM, { size: 6, maxW: c.w });
            } else {
              drawLeft(doc2, row[c.key], c.x, y + 1.5 * MM, { size: 6, maxW: c.w });
            }
          }

          // Adjustment detail lines (advances/deductions per entry)
          const adjs = adjByEntry[e.id] || [];
          y += ROW_H;
          rowIdx++;

          for (const adj of adjs) {
            if (y + 5 * MM > LH - LBOTTOM) {
              doc2.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
              y = pageHeader(doc2);
              rowIdx = 0;
            }
            fillRect(doc2, LM, y, LCW, 5 * MM, '#F9F9F9');
            const adjLabel = `  >> ${adj.adj_type.toUpperCase()}: ${adj.description}`;
            drawLeft(doc2, adjLabel, cols[0].x, y + 0.8 * MM, { size: 5.5, color: '#777777' });
            drawRight(doc2, `${adj.is_deduction ? '-' : '+'}KES ${fmtKes(adj.amount)}`, cols[0].x + 200 * MM, y + 0.8 * MM, { size: 5.5, color: adj.is_deduction ? '#C62828' : '#2E7D32' });
            y += 5 * MM;
          }
        }

        // ── Totals row ──────────────────────────────────────────────────────
        if (y + ROW_H * 1.5 > LH - LBOTTOM) {
          doc2.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
          y = pageHeader(doc2);
        }
        y += 2 * MM;
        fillRect(doc2, LM, y, LCW, ROW_H + 2 * MM, DKROW);
        drawLeft(doc2, `TOTALS  (${entries.length} employees)`, cols[0].x, y + 2.5 * MM, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
        const totals = { gross: tGross, sha: tSha, advance: tAdv, damage: tDmg, other: tOth, total_d: tDed, net: tNet, paid: tPaid, balance: tBal };
        for (const [k, v] of Object.entries(totals)) {
          const c = cols.find(x => x.key === k);
          if (c) drawRight(doc2, fmtKes(v), c.x + c.w, y + 2.5 * MM, { font: 'Helvetica-Bold', size: 6.5, color: WHITE });
        }

        // ── Footer ──────────────────────────────────────────────────────────
        fillRect(doc2, 0, LH - LBOTTOM, LW, LBOTTOM, DKROW);
        drawCenter(doc2, 'Canvas Guy Limited  ·  Confidential Payroll Document', LW / 2, LH - LBOTTOM + 5 * MM, { size: 7, color: WHITE, font: 'Helvetica-Bold' });

        doc2.end();
        return;
      }

      // ════════════════════════════════════════════════════════════════════════
      // EMPLOYEE PAYROLL REPORT  (portrait A4)
      // data.employeePayrollReport = {
      //   employee, dateFrom, dateTo,
      //   runs [{ run, entry, adjustments }],   ← approved/closed in period only
      //   payments [],                           ← confirmed payments in period
      //   balanceBF, balanceCF,
      //   periodSummary { gross, sha, advances, damage, other, netPay, paymentsMade }
      // }
      // ════════════════════════════════════════════════════════════════════════
      if (data.employeePayrollReport) {
        const {
          employee,
          dateFrom: eFrom,
          dateTo:   eTo,
          runs:     empRuns     = [],
          payments: empPayments = [],
          balanceBF  = 0,
          balanceCF  = 0,
          periodSummary = {},
        } = data.employeePayrollReport;

        const doc3 = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 0, autoFirstPage: true });
        const bufs3 = [];
        doc3.on('data', c => bufs3.push(c));
        doc3.on('end', () => resolve(Buffer.concat(bufs3)));

        const typeLabel3 = { casual: 'Casual', permanent: 'Permanent', skilled_casual: 'Skilled', combined: 'Combined' };
        const statusColor3 = { paid: '#2E7D32', part_paid: '#E65100', unpaid: '#C62828' };

        // ── Payroll History columns ──────────────────────────────────────────
        const eCols = mmCols([
          { key: 'run_num',  label: 'Run #',       x: PM/MM,        w: 22 },
          { key: 'period',   label: 'Period',      x: PM/MM + 22,   w: 34 },
          { key: 'days',     label: 'Days',        x: PM/MM + 56,   w: 10 },
          { key: 'gross',    label: 'Gross',       x: PM/MM + 66,   w: 22 },
          { key: 'sha',      label: 'SHA',         x: PM/MM + 88,   w: 18 },
          { key: 'advances', label: 'Advances',    x: PM/MM + 106,  w: 20 },
          { key: 'other_d',  label: 'Other Ded.', x: PM/MM + 126,  w: 18 },
          { key: 'net',      label: 'Net Pay',     x: PM/MM + 144,  w: 22 },
          { key: 'status',   label: 'Status',      x: PM/MM + 166,  w: 20 },
        ]);

        // ── Payment History columns ──────────────────────────────────────────
        const pCols = mmCols([
          { key: 'date',      label: 'Date',           x: PM/MM,        w: 24 },
          { key: 'method',    label: 'Method',         x: PM/MM + 24,   w: 22 },
          { key: 'reference', label: 'Reference',      x: PM/MM + 46,   w: 48 },
          { key: 'run',       label: 'Run Applied To', x: PM/MM + 94,   w: 44 },
          { key: 'amount',    label: 'Amount (KES)',   x: PM/MM + 138,  w: 48 },
        ]);

        // ── Draw column header bar ───────────────────────────────────────────
        function drawEColHeaders(d, yy, cols) {
          fillRect(d, PM, yy, PCW, HDR_H, DKROW);
          for (const c of cols) {
            if (['gross','sha','advances','other_d','net','amount'].includes(c.key)) {
              drawRight(d, c.label, c.x + c.w, yy + 1.5 * MM, { font: 'Helvetica-Bold', size: 5.5, color: WHITE });
            } else {
              drawLeft(d, c.label, c.x, yy + 1.5 * MM, { font: 'Helvetica-Bold', size: 5.5, color: WHITE });
            }
          }
          return yy + HDR_H;
        }

        // ── Continuation page header ─────────────────────────────────────────
        function drawContHeader(title) {
          fillRect(doc3, 0, 0, PW, 16 * MM, CORAL);
          if (HAS_LOGO) { try { doc3.image(LOGO_PATH, PM, 2 * MM, { height: 11 * MM }); } catch (e) {} }
          doc3.font('Helvetica-Bold').fontSize(9).fillColor(WHITE)
             .text(employee.name + ' — ' + title, PM + 40 * MM, 3 * MM, { lineBreak: false });
          doc3.font('Helvetica').fontSize(7).fillColor(WHITE)
             .text('Period: ' + fmtDate(eFrom) + ' – ' + fmtDate(eTo), PM + 40 * MM, 10 * MM, { lineBreak: false });
          return 19 * MM;
        }

        // ── First-page full header (employee details + period summary) ───────
        function drawFirstPageHeader() {
          fillRect(doc3, 0, 0, PW, 30 * MM, CORAL);
          if (HAS_LOGO) { try { doc3.image(LOGO_PATH, PM, 5 * MM, { height: 16 * MM }); } catch (e) {} }
          doc3.font('Helvetica-Bold').fontSize(13).fillColor(WHITE)
             .text('EMPLOYEE PAYROLL REPORT', PM + 42 * MM, 7 * MM, { lineBreak: false });
          const genDate = new Date().toLocaleDateString('en-KE', { day:'2-digit', month:'short', year:'numeric' });
          doc3.font('Helvetica').fontSize(7.5).fillColor(WHITE)
             .text('Generated: ' + genDate, PM + 42 * MM, 18 * MM, { lineBreak: false });
          drawRight(doc3, 'Period: ' + fmtDate(eFrom) + ' – ' + fmtDate(eTo), PM + PCW, 18 * MM, { size: 7.5, color: WHITE });

          let y = 34 * MM;

          // Employee details panel
          fillRect(doc3, PM, y, PCW, 3 * MM, DKROW);
          doc3.font('Helvetica-Bold').fontSize(6.5).fillColor(WHITE)
             .text('EMPLOYEE DETAILS', PM + 2 * MM, y + 0.6 * MM, { lineBreak: false });
          y += 3 * MM;
          fillRect(doc3, PM, y, PCW, 28 * MM, LGRAY);

          const empType = typeLabel3[employee.type] || employee.type || '—';
          doc3.font('Helvetica-Bold').fontSize(11).fillColor(DKROW)
             .text(employee.name || '—', PM + 3 * MM, y + 3 * MM, { lineBreak: false });
          doc3.font('Helvetica').fontSize(7).fillColor('#555555')
             .text('#' + (employee.employee_num || '—') + '  ·  ' + empType, PM + 3 * MM, y + 11 * MM, { lineBreak: false });
          const statusLabel = employee.is_active === false ? 'INACTIVE' : 'ACTIVE';
          const statusCol   = employee.is_active === false ? '#C62828' : '#2E7D32';
          doc3.font('Helvetica-Bold').fontSize(6.5).fillColor(statusCol)
             .text(statusLabel, PM + 3 * MM, y + 18 * MM, { lineBreak: false });

          const rightX = PM + PCW / 2;
          const infoRows = [
            ['Phone',         employee.phone      || '—'],
            ['National ID',   employee.id_number  || '—'],
            ['SHA Deduction', employee.sha_amount != null ? 'KES ' + fmtKes(employee.sha_amount) + '/run' : '—'],
            ['Start Date',    employee.hire_date  ? fmtDate(employee.hire_date) : '—'],
          ];
          infoRows.forEach(function(pair, i) {
            doc3.font('Helvetica').fontSize(6.5).fillColor('#777777')
               .text(pair[0] + ':', rightX, y + 3 * MM + i * 6.5 * MM, { lineBreak: false });
            doc3.font('Helvetica-Bold').fontSize(6.5).fillColor(DGRAY)
               .text(pair[1], rightX + 28 * MM, y + 3 * MM + i * 6.5 * MM, { lineBreak: false });
          });
          y += 31 * MM;

          // Period Summary panel
          fillRect(doc3, PM, y, PCW, 3 * MM, DKROW);
          doc3.font('Helvetica-Bold').fontSize(6.5).fillColor(WHITE)
             .text('PERIOD SUMMARY', PM + 2 * MM, y + 0.6 * MM, { lineBreak: false });
          y += 3 * MM;
          fillRect(doc3, PM, y, PCW, 48 * MM, '#FAFAFA');

          const pSum = periodSummary;
          const sumMid = PM + PCW / 2 + 2 * MM;

          const leftItems = [
            ['Balance Brought Forward', balanceBF],
            ['Gross Earnings',          pSum.gross    || 0],
            ['SHA Deductions',          pSum.sha      || 0],
            ['Advances',                pSum.advances || 0],
            ['Damage Deductions',       pSum.damage   || 0],
            ['Other Deductions',        pSum.other    || 0],
          ];
          const rightItems = [
            ['Net Pay Earned',          pSum.netPay       || 0, CORAL],
            ['Payments Made',           pSum.paymentsMade || 0, '#2E7D32'],
            ['Balance Carried Forward', balanceCF,             balanceCF < 0 ? '#C62828' : DKROW],
          ];

          leftItems.forEach(function(item, i) {
            const label = item[0], val = item[1];
            const ly = y + 4 * MM + i * 7 * MM;
            doc3.font('Helvetica').fontSize(6.5).fillColor('#666666').text(label + ':', PM + 3 * MM, ly, { lineBreak: false });
            const valStr = 'KES ' + (val < 0 ? '-' : '') + fmtKes(Math.abs(val));
            const vc = label.includes('Brought') && val < 0 ? '#C62828' : DGRAY;
            doc3.font('Helvetica-Bold').fontSize(6.5).fillColor(vc)
               .text(valStr, PM + 3 * MM + 35 * MM, ly, { align: 'right', width: 25 * MM, lineBreak: false });
          });

          rightItems.forEach(function(item, i) {
            const label = item[0], val = item[1], col = item[2];
            const ry = y + 4 * MM + i * 9 * MM;
            doc3.font('Helvetica').fontSize(6.5).fillColor('#666666').text(label + ':', sumMid, ry, { lineBreak: false });
            const valStr = 'KES ' + (val < 0 ? '-' : '') + fmtKes(Math.abs(val));
            doc3.font('Helvetica-Bold').fontSize(7).fillColor(col)
               .text(valStr, sumMid + 35 * MM, ry, { align: 'right', width: 25 * MM, lineBreak: false });
          });

          y += 51 * MM;
          return y;
        }

        // ═══ Page 1: employee details + period summary + payroll history ════
        let y3 = drawFirstPageHeader();

        fillRect(doc3, PM, y3, PCW, 5 * MM, '#E8E8E8');
        doc3.font('Helvetica-Bold').fontSize(7).fillColor(DKROW)
           .text('PAYROLL HISTORY  (' + empRuns.length + ' approved/closed run' + (empRuns.length !== 1 ? 's' : '') + ')', PM + 3 * MM, y3 + 1 * MM, { lineBreak: false });
        y3 += 5 * MM;
        y3 = drawEColHeaders(doc3, y3, eCols);

        let rowIdx3 = 0;
        let tGross3 = 0, tSha3 = 0, tAdv3 = 0, tOth3 = 0, tNet3 = 0;

        for (const item of empRuns) {
          const { run, entry, adjustments: adjs = [] } = item;
          if (!entry) continue;

          if (y3 + ROW_H > PH - PBOTTOM) {
            doc3.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
            y3 = drawContHeader('Payroll History (continued)');
            y3 = drawEColHeaders(doc3, y3, eCols);
            rowIdx3 = 0;
          }

          const gross      = Number(entry.gross_pay        || 0);
          const sha        = Number(entry.sha_deduction     || 0);
          const advance    = Number(entry.advance_deduction || 0);
          const damage     = Number(entry.damage_deduction  || 0);
          const other      = Number(entry.other_deductions  || 0);
          const net        = Number(entry.net_pay           || 0);
          const otherTotal = damage + other;

          tGross3 += gross; tSha3 += sha; tAdv3 += advance; tOth3 += otherTotal; tNet3 += net;

          fillRect(doc3, PM, y3, PCW, ROW_H, rowIdx3 % 2 === 0 ? WHITE : LGRAY);
          const rowData = {
            run_num:  run.run_num,
            period:   fmtDate(run.period_start) + ' – ' + fmtDate(run.period_end),
            days:     String(entry.days_worked != null ? entry.days_worked : '—'),
            gross:    fmtKes(gross),
            sha:      sha > 0 ? fmtKes(sha) : '—',
            advances: advance > 0 ? fmtKes(advance) : '—',
            other_d:  otherTotal > 0 ? fmtKes(otherTotal) : '—',
            net:      fmtKes(net),
            status:   entry.payment_status || '—',
          };

          for (const c of eCols) {
            if (c.key === 'status') {
              drawLeft(doc3, rowData.status.toUpperCase(), c.x, y3 + 1.5 * MM, { size: 5.5, font: 'Helvetica-Bold', color: statusColor3[entry.payment_status] || DGRAY, maxW: c.w });
            } else if (['gross','sha','advances','other_d','net'].includes(c.key)) {
              drawRight(doc3, rowData[c.key], c.x + c.w, y3 + 1.5 * MM, { size: 6, maxW: c.w });
            } else {
              drawLeft(doc3, rowData[c.key], c.x, y3 + 1.5 * MM, { size: 6, maxW: c.w });
            }
          }
          y3 += ROW_H;
          rowIdx3++;

          for (const adj of adjs) {
            if (y3 + 5 * MM > PH - PBOTTOM) {
              doc3.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
              y3 = drawContHeader('Payroll History (continued)');
              y3 = drawEColHeaders(doc3, y3, eCols);
              rowIdx3 = 0;
            }
            fillRect(doc3, PM, y3, PCW, 5 * MM, '#F9F9F9');
            drawLeft(doc3, '  >> ' + String(adj.adj_type || '').toUpperCase() + ': ' + (adj.description || ''), eCols[0].x, y3 + 0.8 * MM, { size: 5.5, color: '#777777' });
            drawRight(doc3, (adj.is_deduction ? '-' : '+') + 'KES ' + fmtKes(adj.amount), PM + PCW, y3 + 0.8 * MM, { size: 5.5, color: adj.is_deduction ? '#C62828' : '#2E7D32' });
            y3 += 5 * MM;
          }
        }

        if (empRuns.length > 0) {
          if (y3 + ROW_H + 2 * MM > PH - PBOTTOM) {
            doc3.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
            y3 = drawContHeader('Payroll History (continued)');
          }
          fillRect(doc3, PM, y3, PCW, ROW_H + 2 * MM, DKROW);
          drawLeft(doc3, 'TOTALS  (' + empRuns.length + ' run' + (empRuns.length !== 1 ? 's' : '') + ')', eCols[0].x, y3 + 2.5 * MM, { font: 'Helvetica-Bold', size: 6, color: WHITE });
          for (const [k, v] of Object.entries({ gross: tGross3, sha: tSha3, advances: tAdv3, other_d: tOth3, net: tNet3 })) {
            const c = eCols.find(x => x.key === k);
            if (c) drawRight(doc3, fmtKes(v), c.x + c.w, y3 + 2.5 * MM, { font: 'Helvetica-Bold', size: 6, color: WHITE });
          }
          y3 += ROW_H + 2 * MM;
        }

        // ═══ Payment History ════════════════════════════════════════════════
        y3 += 6 * MM;
        if (y3 + 20 * MM > PH - PBOTTOM) {
          doc3.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
          y3 = drawContHeader('Payment History');
        }
        fillRect(doc3, PM, y3, PCW, 5 * MM, '#E8E8E8');
        doc3.font('Helvetica-Bold').fontSize(7).fillColor(DKROW)
           .text('PAYMENT HISTORY  (' + empPayments.length + ' confirmed payment' + (empPayments.length !== 1 ? 's' : '') + ')', PM + 3 * MM, y3 + 1 * MM, { lineBreak: false });
        y3 += 5 * MM;
        y3 = drawEColHeaders(doc3, y3, pCols);

        let pRowIdx = 0;
        let tPaid3 = 0;

        if (empPayments.length === 0) {
          fillRect(doc3, PM, y3, PCW, ROW_H, LGRAY);
          drawLeft(doc3, 'No payments recorded in this period.', pCols[0].x, y3 + 1.5 * MM, { size: 6, color: '#999999' });
          y3 += ROW_H;
        } else {
          for (const pmt of empPayments) {
            if (y3 + ROW_H > PH - PBOTTOM) {
              doc3.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
              y3 = drawContHeader('Payment History (continued)');
              y3 = drawEColHeaders(doc3, y3, pCols);
              pRowIdx = 0;
            }
            const amt = Number(pmt.amount || 0);
            tPaid3 += amt;
            fillRect(doc3, PM, y3, PCW, ROW_H, pRowIdx % 2 === 0 ? WHITE : LGRAY);
            const pmtData = {
              date:      fmtDate(pmt.payment_date),
              method:    String(pmt.payment_method || '—').toUpperCase(),
              reference: pmt.reference || pmt.phone || '—',
              run:       pmt._runNum || '—',
              amount:    fmtKes(amt),
            };
            for (const c of pCols) {
              if (c.key === 'amount') {
                drawRight(doc3, pmtData.amount, c.x + c.w, y3 + 1.5 * MM, { size: 6, color: '#2E7D32', font: 'Helvetica-Bold' });
              } else {
                drawLeft(doc3, pmtData[c.key], c.x, y3 + 1.5 * MM, { size: 6, maxW: c.w });
              }
            }
            y3 += ROW_H;
            pRowIdx++;
          }
          if (y3 + ROW_H + 2 * MM > PH - PBOTTOM) {
            doc3.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
            y3 = drawContHeader('Payment History (continued)');
          }
          fillRect(doc3, PM, y3, PCW, ROW_H + 2 * MM, DKROW);
          drawLeft(doc3, 'TOTAL PAYMENTS  (' + empPayments.length + ')', pCols[0].x, y3 + 2.5 * MM, { font: 'Helvetica-Bold', size: 6, color: WHITE });
          drawRight(doc3, fmtKes(tPaid3), pCols[pCols.length - 1].x + pCols[pCols.length - 1].w, y3 + 2.5 * MM, { font: 'Helvetica-Bold', size: 6, color: '#4ADE80' });
          y3 += ROW_H + 2 * MM;
        }

        // ═══ Closing balance block ═══════════════════════════════════════════
        y3 += 6 * MM;
        if (y3 + 22 * MM > PH - PBOTTOM) {
          doc3.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
          y3 = drawContHeader('Balance Summary');
        }
        const balBgColor   = balanceCF < 0 ? '#FEF2F2' : '#F0FDF4';
        const balTextColor = balanceCF < 0 ? '#C62828' : '#2E7D32';
        fillRect(doc3, PM, y3, PCW, 18 * MM, balBgColor);
        doc3.font('Helvetica-Bold').fontSize(8).fillColor(balTextColor)
           .text('CLOSING BALANCE', PM + 3 * MM, y3 + 3 * MM, { lineBreak: false });
        doc3.font('Helvetica').fontSize(6.5).fillColor('#555555')
           .text('Balance B/F  +  Net Pay Earned  -  Payments Made', PM + 3 * MM, y3 + 9 * MM, { lineBreak: false });
        const cfStr = 'KES ' + (balanceCF < 0 ? '-' : '') + fmtKes(Math.abs(balanceCF));
        drawRight(doc3, cfStr, PM + PCW - 3 * MM, y3 + 4 * MM, { font: 'Helvetica-Bold', size: 12, color: balTextColor });
        y3 += 20 * MM;

        fillRect(doc3, 0, PH - PBOTTOM, PW, PBOTTOM, DKROW);
        drawCenter(doc3, 'Canvas Guy Limited  ·  Confidential Payroll Document', PW / 2, PH - PBOTTOM + 5 * MM, { size: 7, color: WHITE, font: 'Helvetica-Bold' });

        doc3.end();
        return;
      }

      // ── Fallback ──────────────────────────────────────────────────────────────
      doc.text('Unknown report type').end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildReportPDF };

// ── Standalone entry point (called as child process by the API route) ──────────
// Reads JSON from stdin, writes PDF bytes to stdout — same pattern as build_report.py
if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', async () => {
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const pdf  = await buildReportPDF(data);
      process.stdout.write(pdf);
    } catch (err) {
      process.stderr.write(err.message || String(err));
      process.exit(1);
    }
  });
}
