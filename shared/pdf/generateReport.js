/**
 * Canvas Guy Tracker — Production Report PDF Generator
 * Uses jsPDF + autoTable, loaded via dynamic import (no SSR)
 */

const ACCENT = [232, 81, 42]; // #E8512A
const DARK = [26, 26, 26];    // #1a1a1a
const GRAY = [136, 136, 136];
const LIGHT_BG = [247, 247, 245];

export async function generateReportPDF({
  title,
  subtitle,
  orders,
  allItems,
  payTotals,
  userName,
  showFinancials = false,
  workloadSummary = null,
}) {
  const { default: jsPDF } = await import("jspdf");
  await import("jspdf-autotable");

  const doc = new jsPDF("landscape", "mm", "a4");
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 14;
  let y = margin;

  // ── Header ──
  doc.setFillColor(...DARK);
  doc.rect(0, 0, pageW, 28, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text("CANVAS GUY", margin, 12);
  doc.setFontSize(9);
  doc.setTextColor(...ACCENT);
  doc.text("TRACKER", margin + 52, 12);
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text(title, margin, 23);

  // Subtitle & date
  doc.setFontSize(9);
  doc.setTextColor(...GRAY);
  y = 34;
  if (subtitle) {
    doc.text(subtitle, margin, y);
    y += 5;
  }
  doc.text(`Generated: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`, margin, y);
  if (userName) {
    doc.text(`By: ${userName}`, margin + 100, y);
  }
  y += 8;

  // ── Workload Summary Card (if provided) ──
  if (workloadSummary) {
    doc.setFillColor(...LIGHT_BG);
    doc.roundedRect(margin, y, pageW - margin * 2, 18, 2, 2, "F");
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...DARK);
    doc.text("WORKLOAD SUMMARY", margin + 4, y + 6);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    let sx = margin + 4;
    workloadSummary.forEach((item) => {
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...ACCENT);
      doc.text(String(item.qty), sx, y + 14);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...GRAY);
      doc.text(item.label, sx + doc.getTextWidth(String(item.qty)) + 2, y + 14);
      sx += 56;
    });
    y += 24;
  }

  // ── Build table data (grouped: Order → Items) ──
  const cols = showFinancials
    ? [
        { header: "Client", dataKey: "client" },
        { header: "Order #", dataKey: "orderNum" },
        { header: "Due Date", dataKey: "dueDate" },
        { header: "Status", dataKey: "status" },
        { header: "Category", dataKey: "category" },
        { header: "Description", dataKey: "description" },
        { header: "Qty", dataKey: "qty" },
        { header: "Size", dataKey: "size" },
        { header: "Finish", dataKey: "finish" },
        { header: "Value (KES)", dataKey: "value" },
        { header: "Paid (KES)", dataKey: "paid" },
        { header: "Balance (KES)", dataKey: "balance" },
      ]
    : [
        { header: "Client", dataKey: "client" },
        { header: "Order #", dataKey: "orderNum" },
        { header: "Due Date", dataKey: "dueDate" },
        { header: "Status", dataKey: "status" },
        { header: "Category", dataKey: "category" },
        { header: "Description", dataKey: "description" },
        { header: "Qty", dataKey: "qty" },
        { header: "Size", dataKey: "size" },
        { header: "Finish", dataKey: "finish" },
        { header: "Wood", dataKey: "wood" },
        { header: "Notes", dataKey: "notes" },
      ];

  const rows = [];
  let totalUnits = 0;

  orders.forEach((order) => {
    const orderItems = allItems[order.id] || [];
    const paid = payTotals[order.id] || 0;
    const tv = parseFloat(order.total_value) || 0;
    const balance = Math.max(tv - paid, 0);
    const dueStr = order.due_date
      ? new Date(order.due_date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : "—";

    if (orderItems.length === 0) {
      // Legacy order with no structured items
      totalUnits += 1;
      const row = {
        client: order.client,
        orderNum: order.order_num,
        dueDate: dueStr,
        status: order.status,
        category: "—",
        description: order.items || "—",
        qty: "—",
        size: "—",
        finish: "—",
        wood: "—",
        notes: order.notes || "",
      };
      if (showFinancials) {
        row.value = fmtNum(tv);
        row.paid = fmtNum(paid);
        row.balance = fmtNum(balance);
      }
      rows.push(row);
    } else {
      orderItems.forEach((item, idx) => {
        totalUnits += item.quantity || 1;
        const row = {
          client: idx === 0 ? order.client : "",
          orderNum: idx === 0 ? order.order_num : "",
          dueDate: idx === 0 ? dueStr : "",
          status: idx === 0 ? order.status : "",
          category: item.category || "—",
          description: item.description || "—",
          qty: String(item.quantity || 1),
          size: item.size || "—",
          finish: [item.finish_type, item.finish_color].filter(Boolean).join(" / ") || "—",
          wood: item.wood_type || "—",
          notes: item.notes || "",
        };
        if (showFinancials && idx === 0) {
          row.value = fmtNum(tv);
          row.paid = fmtNum(paid);
          row.balance = fmtNum(balance);
        } else if (showFinancials) {
          row.value = "";
          row.paid = "";
          row.balance = "";
        }
        rows.push(row);
      });
    }
  });

  // ── Render table ──
  doc.autoTable({
    startY: y,
    columns: cols,
    body: rows,
    theme: "grid",
    styles: { fontSize: 8, cellPadding: 2.5, lineColor: [220, 220, 215], lineWidth: 0.3 },
    headStyles: { fillColor: DARK, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 8 },
    alternateRowStyles: { fillColor: [250, 250, 248] },
    columnStyles: showFinancials
      ? { qty: { halign: "center" }, value: { halign: "right" }, paid: { halign: "right" }, balance: { halign: "right" } }
      : { qty: { halign: "center" } },
    margin: { left: margin, right: margin },
    didParseCell: (data) => {
      // Bold the first item row of each order (client/order# cells)
      if (data.section === "body" && data.row.raw.client && (data.column.dataKey === "client" || data.column.dataKey === "orderNum")) {
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  // ── Footer ──
  const finalY = doc.lastAutoTable.finalY + 8;
  if (finalY < pageH - 20) {
    doc.setDrawColor(...LIGHT_BG);
    doc.setLineWidth(0.5);
    doc.line(margin, finalY, pageW - margin, finalY);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...DARK);
    doc.text(`Total Orders: ${orders.length}`, margin, finalY + 6);
    doc.text(`Total Units: ${totalUnits}`, margin + 50, finalY + 6);
    if (showFinancials) {
      const totalVal = orders.reduce((s, o) => s + (parseFloat(o.total_value) || 0), 0);
      const totalPaid = orders.reduce((s, o) => s + (payTotals[o.id] || 0), 0);
      doc.text(`Total Value: KES ${fmtNum(totalVal)}`, margin + 100, finalY + 6);
      doc.text(`Outstanding: KES ${fmtNum(totalVal - totalPaid)}`, margin + 165, finalY + 6);
    }
  }

  // ── Page numbers ──
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(...GRAY);
    doc.text(`Page ${i} of ${pageCount}`, pageW - margin - 20, pageH - 6);
    doc.text("Canvas Guy Tracker", margin, pageH - 6);
  }

  // ── Save ──
  const safeTitle = title.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
  const dateStr = new Date().toISOString().split("T")[0];
  doc.save(`${safeTitle}_${dateStr}.pdf`);
}

function fmtNum(n) {
  return n ? Math.round(n).toLocaleString("en-KE") : "0";
}
