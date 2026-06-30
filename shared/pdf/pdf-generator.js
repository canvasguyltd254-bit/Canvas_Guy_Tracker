/**
 * Canvas Guy Tracker — Order PDF Generator
 * Dual output: 'internal' (full costs) and 'customer' (total only)
 * Uses jsPDF + autoTable, loaded via dynamic import (no SSR).
 */

const CORAL = [232, 81, 42];   // #E8512A
const DARK = [26, 26, 26];     // #1a1a1a
const GRAY = [136, 136, 136];
const LIGHT_BG = [247, 247, 245];
const WHITE = [255, 255, 255];

function fmtKES(n) {
  return 'KES ' + (parseFloat(n) || 0).toLocaleString('en-KE', { minimumFractionDigits: 0 });
}

function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Generate an order PDF.
 * @param {Object} params
 * @param {Object} params.order - Order record from Supabase
 * @param {Array}  params.items - Order items
 * @param {Array}  params.payments - Payment records
 * @param {Array}  params.deliveries - Delivery records
 * @param {number} params.totalValue
 * @param {number} params.totalPaid
 * @param {number} params.balanceDue
 * @param {'internal'|'customer'} params.type
 * @returns {Promise<jsPDF>}
 */
export async function generateOrderPDF({
  order,
  items = [],
  payments = [],
  deliveries = [],
  totalValue = 0,
  totalPaid = 0,
  balanceDue = 0,
  type = 'customer',
}) {
  const { default: jsPDF } = await import('jspdf');
  await import('jspdf-autotable');

  const doc = new jsPDF('portrait', 'mm', 'a4');
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = margin;

  // ── Header Bar ──────────────────────────────────────────────────
  doc.setFillColor(...CORAL);
  doc.rect(0, 0, pageW, 22, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...WHITE);
  doc.text('CANVAS GUY LIMITED', margin, 14);

  const typeLabel = type === 'internal' ? 'INTERNAL COPY' : 'ORDER CONFIRMATION';
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(typeLabel, pageW - margin, 14, { align: 'right' });

  y = 30;

  // ── Order Number + Client ────────────────────────────────────────
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK);
  doc.text(order.order_num || '-', margin, y);
  y += 7;

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(order.client || '-', margin, y);
  y += 6;

  if (order.contact_person) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text('Contact: ' + order.contact_person, margin, y);
    y += 5;
  }

  // Status chip
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(margin, y, 32, 6, 1.5, 1.5, 'F');
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text((order.status || '').toUpperCase(), margin + 4, y + 4);
  y += 12;

  // ── Meta Grid ───────────────────────────────────────────────────
  const metaFields = [
    ['Order Date', fmtDate(order.created_at)],
    ['Due Date', fmtDate(order.due_date)],
    ['Payment Terms', order.payment_terms || '-'],
    ['Customer Type', order.customer_type || 'Retail'],
  ];

  if (type === 'internal') {
    metaFields.push(
      ['Quote #', order.quote_number || '-'],
      ['Invoice #', order.invoice_number || '-'],
      ['Sales Rep', order.author || '-'],
      ['Assigned To', order.assigned_to || '-'],
    );
  } else {
    if (order.invoice_number) metaFields.push(['Invoice #', order.invoice_number]);
    if (order.quote_number) metaFields.push(['Quote #', order.quote_number]);
  }

  const colW = (pageW - margin * 2) / 2;
  metaFields.forEach(([label, val], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = margin + col * colW;
    const rowY = y + row * 9;

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text(label.toUpperCase(), x, rowY);

    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK);
    doc.text(String(val), x, rowY + 4.5);
  });

  y += Math.ceil(metaFields.length / 2) * 9 + 8;

  // ── Divider ─────────────────────────────────────────────────────
  doc.setDrawColor(...CORAL);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 8;

  // ── Items Table ─────────────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK);
  doc.text('Order Items', margin, y);
  y += 4;

  const isInternal = type === 'internal';
  const tableColumns = isInternal
    ? [
        { header: 'Category', dataKey: 'cat' },
        { header: 'Description', dataKey: 'desc' },
        { header: 'Qty', dataKey: 'qty' },
        { header: 'Unit Price', dataKey: 'unit' },
        { header: 'Total', dataKey: 'total' },
      ]
    : [
        { header: 'Category', dataKey: 'cat' },
        { header: 'Description', dataKey: 'desc' },
        { header: 'Qty', dataKey: 'qty' },
      ];

  const tableRows = items.map(item => {
    const qty = item.quantity || 1;
    const unitPrice = parseFloat(item.unit_price) || 0;
    const specParts = [item.size, item.finish_type, item.finish_color, item.wood_type].filter(Boolean);
    const desc = specParts.join(' · ') || item.description || '-';

    const row = { cat: item.category || '-', desc, qty: String(qty) };
    if (isInternal) {
      row.unit = fmtKES(unitPrice);
      row.total = fmtKES(unitPrice * qty);
    }
    return row;
  });

  doc.autoTable({
    startY: y,
    columns: tableColumns,
    body: tableRows,
    margin: { left: margin, right: margin },
    styles: { fontSize: 9, cellPadding: 3, textColor: [...DARK] },
    headStyles: { fillColor: [...LIGHT_BG], textColor: [...GRAY], fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: [252, 252, 251] },
    columnStyles: isInternal
      ? { qty: { halign: 'right' }, unit: { halign: 'right' }, total: { halign: 'right', fontStyle: 'bold' } }
      : { qty: { halign: 'right' } },
  });

  y = doc.lastAutoTable.finalY + 10;

  // ── Financial Summary ───────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK);
  doc.text('Financial Summary', margin, y);
  y += 6;

  const summaryRows = [];

  if (isInternal) {
    summaryRows.push(['Subtotal', fmtKES(totalValue)]);
    payments.forEach(p => {
      summaryRows.push([`  ${p.description} (${fmtDate(p.payment_date)})`, fmtKES(p.amount)]);
    });
    summaryRows.push(['Total Paid', fmtKES(totalPaid)]);
    summaryRows.push(['Balance Due', fmtKES(balanceDue)]);
  } else {
    summaryRows.push(['Total Amount Due', fmtKES(totalValue)]);
    if (order.payment_terms) summaryRows.push(['Payment Terms', order.payment_terms]);
  }

  doc.autoTable({
    startY: y,
    body: summaryRows,
    margin: { left: pageW / 2, right: margin },
    styles: { fontSize: 10, cellPadding: 3 },
    bodyStyles: { textColor: [...DARK] },
    columnStyles: { 0: { fontStyle: 'normal', textColor: [...GRAY] }, 1: { halign: 'right', fontStyle: 'bold' } },
    didParseCell: (data) => {
      const isLast = data.row.index === summaryRows.length - 1;
      if (isLast) {
        data.cell.styles.fontSize = 11;
        data.cell.styles.fillColor = [...LIGHT_BG];
        data.cell.styles.textColor = isInternal && balanceDue > 0 ? [198, 40, 40] : [46, 125, 50];
        data.cell.styles.fontStyle = 'bold';
      }
    },
  });

  y = doc.lastAutoTable.finalY + 10;

  // ── Notes (internal only) ────────────────────────────────────────
  if (isInternal && order.notes) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK);
    doc.text('Notes', margin, y);
    y += 5;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    const lines = doc.splitTextToSize(order.notes, pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 5 + 8;
  }

  // ── Delivery Summary ─────────────────────────────────────────────
  if (deliveries.length > 0) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK);
    doc.text('Delivery', margin, y);
    y += 4;

    doc.autoTable({
      startY: y,
      columns: [
        { header: 'Batch', dataKey: 'batch' },
        { header: 'Qty', dataKey: 'qty' },
        { header: 'Location', dataKey: 'loc' },
        { header: 'Date', dataKey: 'date' },
      ],
      body: deliveries.map(d => ({
        batch: String(d.batch_number),
        qty: String(d.quantity),
        loc: d.delivery_location || '-',
        date: fmtDate(d.delivery_date || d.created_at),
      })),
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 3, textColor: [...DARK] },
      headStyles: { fillColor: [...LIGHT_BG], textColor: [...GRAY], fontStyle: 'bold', fontSize: 8 },
    });

    y = doc.lastAutoTable.finalY + 10;
  }

  // ── Drawings Note ────────────────────────────────────────────────
  doc.setFontSize(9);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(...GRAY);
  doc.text('For drawings and technical specifications, see attached documents.', margin, y);
  y += 10;

  // ── Footer ───────────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const pageH = doc.internal.pageSize.getHeight();
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text('Canvas Guy Limited · Nairobi, Kenya', margin, pageH - 8);
    doc.text(`Page ${i} of ${pageCount}`, pageW - margin, pageH - 8, { align: 'right' });
    doc.text(new Date().toLocaleDateString('en-GB'), pageW / 2, pageH - 8, { align: 'center' });
  }

  return doc;
}

/**
 * Trigger browser download of a jsPDF document.
 * @param {jsPDF} doc
 * @param {string} fileName
 */
export function downloadPDF(doc, fileName) {
  doc.save(fileName);
}
