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

const PDFDocument = require('pdfkit');

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
  drawRight(doc, 'Colorful Spaces  |  1408-01000 Thika  |  Holla@canvasguy.co.ke  |  0713-196-650',
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
 * Draw portrait page header. Returns y where content begins.
 * If first=true, also draws the customer info box.
 */
function drawPortraitHeader(doc, subtitle, nowStr, user, pageNum, first, cust) {
  // Coral top band
  fillRect(doc, 0, 0, PW, 13 * MM, CORAL);
  drawLeft(doc, 'CANVAS GUY LIMITED', PM, 4 * MM,
    { font: 'Helvetica-Bold', size: 10, color: WHITE });
  drawRight(doc, 'Colorful Spaces  |  1408-01000 Thika  |  Holla@canvasguy.co.ke  |  0713-196-650',
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
