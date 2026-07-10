#!/usr/bin/env python3
"""
Canvas Guy Tracker — Report PDF Generator
Reads JSON from stdin, writes PDF bytes to stdout.

Input JSON shape:
{
  "reportLabel":     str,    e.g. "In Production"
  "orders":          list,
  "allItems":        dict,   order_id -> list of items
  "payTotals":       dict,   order_id -> float
  "dateFrom":        str,    ISO datetime or null
  "dateTo":          str,    ISO datetime or null
  "userName":        str,
  "showFinancials":  bool,
  "workloadSummary": list or null   [{label, qty}]
}

Install: pip install reportlab --break-system-packages
"""

import sys
import json
import io
from datetime import datetime

from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib import colors
from reportlab.lib.units import mm

# ── Brand constants ────────────────────────────────────────────────────────────
CORAL  = colors.HexColor("#E8512A")
BLACK  = colors.black
WHITE  = colors.white
LGRAY  = colors.HexColor("#F5F5F5")
MGRAY  = colors.HexColor("#CCCCCC")
DGRAY  = colors.HexColor("#444444")
DKROW  = colors.HexColor("#2A2A2A")   # column-header row background

PW, PH    = landscape(A4)             # ≈ 841.9 × 595.3 pt  (297 × 210 mm)
M         = 12 * mm                   # page margin
CW        = PW - 2 * M               # content width ≈ 273 mm
BOTTOM    = 18 * mm                   # bottom margin
ROW_H     = 6.5 * mm
COL_HDR_H = 7 * mm


# ── Formatters ─────────────────────────────────────────────────────────────────
def fmt_kes(n):
    try:
        return f"{int(float(n or 0)):,}"
    except (ValueError, TypeError):
        return "0"


def fmt_date(s):
    if not s:
        return "—"
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        # %-d is Linux-only; use lstrip("0") for cross-platform compatibility
        return f"{d.day} {d.strftime('%b')} {d.year}"
    except Exception:
        return str(s)[:10]


def clip(c, text, max_w_mm, font="Helvetica", size=6.5):
    """Truncate text to fit within max_w_mm millimetres."""
    text = str(text or "—")
    limit = max_w_mm - 1 * mm
    while c.stringWidth(text, font, size) > limit and len(text) > 1:
        text = text[:-2] + "…"
    return text


# ── Page header ────────────────────────────────────────────────────────────────
def draw_header(c, label, subtitle, date_str, user, page_num):
    """Canvas Guy brand header. Returns y below the ruled line."""
    # Coral top band
    c.setFillColor(CORAL)
    c.rect(0, PH - 13 * mm, PW, 13 * mm, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(M, PH - 8.5 * mm, "CANVAS GUY LIMITED")
    c.setFont("Helvetica", 6.5)
    c.drawRightString(
        PW - M, PH - 7 * mm,
        "Colorful Spaces  |  1408-01000 Thika  |  Holla@canvasguy.co.ke  |  0713-196-650",
    )

    y = PH - 21 * mm
    c.setFillColor(DGRAY)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(M, y, label.upper())
    c.setFont("Helvetica", 7)
    c.drawRightString(PW - M, y, f"{date_str}   |   Page {page_num}")

    y -= 4.5 * mm
    c.setFillColor(DGRAY)
    c.setFont("Helvetica", 7)
    if subtitle:
        c.drawString(M, y, subtitle)
    if user:
        c.drawRightString(PW - M, y, f"By: {user}")

    y -= 3 * mm
    c.setStrokeColor(MGRAY)
    c.setLineWidth(0.4)
    c.line(M, y, PW - M, y)
    return y - 3 * mm


# ── Workload category cards ────────────────────────────────────────────────────
def draw_workload_cards(c, y, items):
    if not items:
        return y

    # Black spec bar
    c.setFillColor(BLACK)
    c.rect(M, y - 8 * mm, CW, 8 * mm, fill=1, stroke=0)
    c.setFillColor(CORAL)
    c.setFont("Helvetica-Bold", 7.5)
    c.drawString(M + 3 * mm, y - 5.5 * mm, "WORKLOAD BY CATEGORY")
    y -= 8 * mm + 3 * mm

    n = len(items)
    card_w = min(38 * mm, (CW - (n - 1) * 3 * mm) / n)
    card_h = 14 * mm
    cx = M
    for cat in items:
        c.setFillColor(LGRAY)
        c.setStrokeColor(MGRAY)
        c.setLineWidth(0.3)
        c.roundRect(cx, y - card_h, card_w, card_h, 1.5 * mm, fill=1, stroke=1)
        c.setFillColor(CORAL)
        c.setFont("Helvetica-Bold", 13)
        c.drawCentredString(cx + card_w / 2, y - 8.5 * mm, str(cat.get("qty", 0)))
        c.setFillColor(DGRAY)
        c.setFont("Helvetica", 5.5)
        c.drawCentredString(cx + card_w / 2, y - 13 * mm, str(cat.get("label", "")))
        cx += card_w + 3 * mm

    return y - card_h - 5 * mm


# ── Section spec bar ───────────────────────────────────────────────────────────
def draw_section_bar(c, y, text):
    c.setFillColor(BLACK)
    c.rect(M, y - 7 * mm, CW, 7 * mm, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 7.5)
    c.drawString(M + 3 * mm, y - 4.8 * mm, text)
    return y - 7 * mm


# ── Column-header row ──────────────────────────────────────────────────────────
def draw_col_headers(c, y, cols):
    c.setFillColor(DKROW)
    c.rect(M, y - COL_HDR_H, CW, COL_HDR_H, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 6.5)
    for col in cols:
        x = M + col["x"]
        if col.get("right"):
            c.drawRightString(x + col["w"] - 1.5 * mm, y - 4.8 * mm, col["header"])
        elif col.get("centre"):
            c.drawCentredString(x + col["w"] / 2, y - 4.8 * mm, col["header"])
        else:
            c.drawString(x + 1.5 * mm, y - 4.8 * mm, col["header"])
    return y - COL_HDR_H


# ── Data row ───────────────────────────────────────────────────────────────────
def draw_data_row(c, y, cols, values, row_idx):
    c.setFillColor(LGRAY if row_idx % 2 == 0 else WHITE)
    c.rect(M, y - ROW_H, CW, ROW_H, fill=1, stroke=0)
    c.setStrokeColor(MGRAY)
    c.setLineWidth(0.2)
    c.line(M, y - ROW_H, M + CW, y - ROW_H)

    for col in cols:
        raw = values.get(col["key"])
        if raw is None or raw == "":
            text = "" if col.get("no_dash") else "—"
        else:
            text = str(raw)

        font_name = "Helvetica-Bold" if col.get("bold") else "Helvetica"
        font_size = col.get("size", 6.5)
        color     = col.get("color", DGRAY)
        max_w     = col["w"] - 3 * mm

        text = clip(c, text, max_w, font_name, font_size)
        c.setFillColor(color)
        c.setFont(font_name, font_size)

        x = M + col["x"]
        if col.get("right"):
            c.drawRightString(x + col["w"] - 1.5 * mm, y - 4.5 * mm, text)
        elif col.get("centre"):
            c.drawCentredString(x + col["w"] / 2, y - 4.5 * mm, text)
        else:
            c.drawString(x + 1.5 * mm, y - 4.5 * mm, text)

    return y - ROW_H


# ── Totals bar (coral) ─────────────────────────────────────────────────────────
def draw_totals(c, y, left_text, right_text=None):
    c.setFillColor(CORAL)
    c.rect(M, y - 8 * mm, CW, 8 * mm, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 7.5)
    c.drawString(M + 3 * mm, y - 5.5 * mm, left_text)
    if right_text:
        c.drawRightString(PW - M - 2 * mm, y - 5.5 * mm, right_text)
    return y - 8 * mm


# ── Column definitions ─────────────────────────────────────────────────────────
# All x values are relative to M; widths sum to CW ≈ 273 mm.

PROD_COLS = [
    {"key": "client",      "header": "Client",      "x":   0*mm, "w": 40*mm, "bold": True},
    {"key": "order_num",   "header": "Order #",     "x":  40*mm, "w": 22*mm, "size": 6},
    {"key": "due_date",    "header": "Due",         "x":  62*mm, "w": 20*mm},
    {"key": "status",      "header": "Status",      "x":  82*mm, "w": 28*mm},
    {"key": "category",    "header": "Category",    "x": 110*mm, "w": 23*mm},
    {"key": "description", "header": "Description", "x": 133*mm, "w": 52*mm},
    {"key": "qty",         "header": "Qty",         "x": 185*mm, "w": 11*mm, "centre": True, "bold": True},
    {"key": "size",        "header": "Size",        "x": 196*mm, "w": 27*mm},
    {"key": "finish",      "header": "Finish",      "x": 223*mm, "w": 27*mm},
    {"key": "wood",        "header": "Wood",        "x": 250*mm, "w": 23*mm},
]

FIN_COLS = [
    {"key": "client",    "header": "Client",        "x":   0*mm, "w": 55*mm, "bold": True},
    {"key": "order_num", "header": "Order #",       "x":  55*mm, "w": 22*mm, "size": 6},
    {"key": "due_date",  "header": "Due Date",      "x":  77*mm, "w": 22*mm},
    {"key": "status",    "header": "Status",        "x":  99*mm, "w": 38*mm},
    {"key": "value",     "header": "Value (KES)",   "x": 137*mm, "w": 40*mm, "right": True},
    {"key": "paid",      "header": "Paid (KES)",    "x": 177*mm, "w": 40*mm, "right": True},
    {"key": "balance",   "header": "Balance (KES)", "x": 217*mm, "w": 56*mm, "right": True, "bold": True},
]

SUPPLIER_COLS = [
    {"key": "supplier_name", "header": "Supplier",      "x":   0*mm, "w": 50*mm, "bold": True},
    {"key": "purchase_date", "header": "Date",          "x":  50*mm, "w": 22*mm},
    {"key": "items_bought",  "header": "Items",         "x":  72*mm, "w": 78*mm},
    {"key": "total",         "header": "Total (KES)",   "x": 150*mm, "w": 35*mm, "right": True},
    {"key": "paid",          "header": "Paid (KES)",    "x": 185*mm, "w": 35*mm, "right": True},
    {"key": "balance",       "header": "Balance (KES)", "x": 220*mm, "w": 35*mm, "right": True, "bold": True},
    {"key": "status",        "header": "Status",        "x": 255*mm, "w": 18*mm},
]

CUSTOMER_REC_COLS = [
    {"key": "name",         "header": "Customer",          "x":   0*mm, "w": 55*mm, "bold": True},
    {"key": "terms",        "header": "Terms",             "x":  55*mm, "w": 20*mm},
    {"key": "total_sales",  "header": "Total Sales (KES)", "x":  75*mm, "w": 40*mm, "right": True},
    {"key": "outstanding",  "header": "Outstanding (KES)", "x": 115*mm, "w": 40*mm, "right": True, "bold": True},
    {"key": "overdue",      "header": "Overdue (KES)",     "x": 155*mm, "w": 38*mm, "right": True},
    {"key": "credit_limit", "header": "Credit Limit",      "x": 193*mm, "w": 38*mm, "right": True},
    {"key": "avail",        "header": "Avail. Credit",     "x": 231*mm, "w": 27*mm, "right": True},
    {"key": "orders",       "header": "Orders",            "x": 258*mm, "w": 15*mm, "centre": True},
]
# 55+20+40+40+38+38+27+15 = 273 ✓

CUSTOMER_ORDER_COLS = [
    {"key": "customer_name", "header": "Customer",      "x":   0*mm, "w": 50*mm, "bold": True},
    {"key": "order_num",     "header": "Order #",       "x":  50*mm, "w": 22*mm, "size": 6},
    {"key": "date",          "header": "Date",          "x":  72*mm, "w": 22*mm},
    {"key": "due_date",      "header": "Due Date",      "x":  94*mm, "w": 22*mm},
    {"key": "status",        "header": "Status",        "x": 116*mm, "w": 38*mm},
    {"key": "value",         "header": "Value (KES)",   "x": 154*mm, "w": 37*mm, "right": True},
    {"key": "paid",          "header": "Paid (KES)",    "x": 191*mm, "w": 37*mm, "right": True},
    {"key": "balance",       "header": "Balance (KES)", "x": 228*mm, "w": 45*mm, "right": True, "bold": True},
]
# 50+22+22+22+38+37+37+45 = 273 ✓

# ── Portrait page dimensions (for customer statements) ─────────────────────────
P_PW, P_PH = A4          # ≈ 595.3 × 841.9 pt  (210 × 297 mm)
P_M        = 12 * mm
P_CW       = P_PW - 2 * P_M   # ≈ 186 mm
P_BOTTOM   = 18 * mm

CUSTOMER_STMT_COLS = [
    {"key": "date",        "header": "Date",          "x":   0*mm, "w": 25*mm},
    {"key": "type",        "header": "Type",          "x":  25*mm, "w": 28*mm},
    {"key": "description", "header": "Description",   "x":  53*mm, "w": 65*mm},
    {"key": "debit",       "header": "Debit (KES)",   "x": 118*mm, "w": 23*mm, "right": True},
    {"key": "credit",      "header": "Credit (KES)",  "x": 141*mm, "w": 23*mm, "right": True},
    {"key": "balance",     "header": "Balance (KES)", "x": 164*mm, "w": 22*mm, "right": True, "bold": True},
]
# 25+28+65+23+23+22 = 186 ✓


# ── Main build ─────────────────────────────────────────────────────────────────
def build(data):
    report_label = data.get("reportLabel", "Report")
    date_from    = data.get("dateFrom")
    date_to      = data.get("dateTo")
    user_name    = data.get("userName", "")

    # Subtitle (date range if present)
    subtitle_parts = []
    if date_from and date_to:
        subtitle_parts.append(f"{fmt_date(date_from)} – {fmt_date(date_to)}")
    subtitle = "  ·  ".join(subtitle_parts) or None

    now     = datetime.now()
    now_str = f"{now.day} {now.strftime('%b')} {now.year}, {now.strftime('%H:%M')}"

    # ── Supplier purchases branch ──────────────────────────────────────────────
    supplier_purchases = data.get("supplierPurchases")
    if supplier_purchases is not None:
        cols = SUPPLIER_COLS
        rows = []
        for p in supplier_purchases:
            t   = float(p.get("total_amount") or 0)
            pd_ = float(p.get("amount_paid") or 0)
            bal = max(t - pd_, 0)
            rows.append({
                "supplier_name": p.get("supplier_name") or p.get("suppliers", {}).get("name", "—") if isinstance(p.get("suppliers"), dict) else p.get("supplier_name", "—"),
                "purchase_date": fmt_date(p.get("purchase_date")),
                "items_bought":  p.get("items_bought") or "—",
                "total":         fmt_kes(t),
                "paid":          fmt_kes(pd_),
                "balance":       fmt_kes(bal),
                "status":        p.get("payment_status", ""),
            })

        buf  = io.BytesIO()
        c    = rl_canvas.Canvas(buf, pagesize=landscape(A4))
        c.setTitle(f"{report_label} — Canvas Guy Tracker")

        page_num = 1
        y = draw_header(c, f"{report_label}", subtitle, now_str, user_name, page_num)
        y = draw_section_bar(c, y, "SUPPLIER PURCHASES")
        y = draw_col_headers(c, y, cols)

        row_idx = 0
        for row in rows:
            if y - ROW_H < BOTTOM:
                c.showPage()
                page_num += 1
                y = draw_header(c, f"{report_label}", subtitle, now_str, user_name, page_num)
                y = draw_section_bar(c, y, "SUPPLIER PURCHASES (continued)")
                y = draw_col_headers(c, y, cols)
            y = draw_data_row(c, y, cols, row, row_idx)
            row_idx += 1

        if y - 10 * mm < BOTTOM:
            c.showPage()
            page_num += 1
            y = draw_header(c, f"{report_label}", subtitle, now_str, user_name, page_num)

        n = len(supplier_purchases)
        total_val  = sum(float(p.get("total_amount") or 0) for p in supplier_purchases)
        total_paid = sum(float(p.get("amount_paid") or 0) for p in supplier_purchases)
        total_bal  = max(total_val - total_paid, 0)
        left  = f"TOTAL  |  {n} purchase{'s' if n != 1 else ''}"
        right = (
            f"Total: KES {fmt_kes(total_val)}   "
            f"Paid: KES {fmt_kes(total_paid)}   "
            f"Outstanding: KES {fmt_kes(total_bal)}"
        )
        draw_totals(c, y - 2 * mm, left, right)
        c.save()
        return buf.getvalue()

    # ── Customer Receivables branch ────────────────────────────────────────────
    customer_receivables = data.get("customerReceivables")
    if customer_receivables is not None:
        cols = CUSTOMER_REC_COLS
        rows = []
        for cust in customer_receivables:
            cl    = float(cust.get("credit_limit") or 0)
            out   = float(cust.get("outstanding")  or 0)
            avail = max(cl - out, 0)
            rows.append({
                "name":         cust.get("name", ""),
                "terms":        cust.get("credit_terms", ""),
                "total_sales":  fmt_kes(cust.get("total_sales", 0)),
                "outstanding":  fmt_kes(out),
                "overdue":      fmt_kes(cust.get("overdue", 0)),
                "credit_limit": fmt_kes(cl) if cl > 0 else "—",
                "avail":        fmt_kes(avail) if cl > 0 else "—",
                "orders":       str(cust.get("total_orders", 0)),
            })

        buf  = io.BytesIO()
        c    = rl_canvas.Canvas(buf, pagesize=landscape(A4))
        c.setTitle(f"{report_label} — Canvas Guy Tracker")

        page_num = 1
        y = draw_header(c, report_label, subtitle, now_str, user_name, page_num)
        y = draw_section_bar(c, y, "CUSTOMER RECEIVABLES")
        y = draw_col_headers(c, y, cols)

        row_idx = 0
        for row in rows:
            if y - ROW_H < BOTTOM:
                c.showPage()
                page_num += 1
                y = draw_header(c, report_label, subtitle, now_str, user_name, page_num)
                y = draw_section_bar(c, y, "CUSTOMER RECEIVABLES (continued)")
                y = draw_col_headers(c, y, cols)
            y = draw_data_row(c, y, cols, row, row_idx)
            row_idx += 1

        if y - 10 * mm < BOTTOM:
            c.showPage()
            page_num += 1
            y = draw_header(c, report_label, subtitle, now_str, user_name, page_num)

        n          = len(customer_receivables)
        total_s    = sum(float(r.get("total_sales")  or 0) for r in customer_receivables)
        total_out  = sum(float(r.get("outstanding")  or 0) for r in customer_receivables)
        total_ovd  = sum(float(r.get("overdue")      or 0) for r in customer_receivables)
        left  = f"TOTAL  |  {n} customer{'s' if n != 1 else ''}"
        right = (
            f"Total Sales: KES {fmt_kes(total_s)}   "
            f"Outstanding: KES {fmt_kes(total_out)}   "
            f"Overdue: KES {fmt_kes(total_ovd)}"
        )
        draw_totals(c, y - 2 * mm, left, right)
        c.save()
        return buf.getvalue()

    # ── Customer Orders branch ─────────────────────────────────────────────────
    customer_orders = data.get("customerOrders")
    if customer_orders is not None:
        cols = CUSTOMER_ORDER_COLS
        rows = []
        for o in customer_orders:
            tv  = float(o.get("total_value")  or 0)
            pd_ = float(o.get("amount_paid")  or 0)
            bal = max(tv - pd_, 0)
            rows.append({
                "customer_name": o.get("customer_name", ""),
                "order_num":     o.get("order_num", ""),
                "date":          fmt_date(o.get("created_at")),
                "due_date":      fmt_date(o.get("due_date")),
                "status":        o.get("status", ""),
                "value":         fmt_kes(tv),
                "paid":          fmt_kes(pd_),
                "balance":       fmt_kes(bal),
            })

        buf  = io.BytesIO()
        c    = rl_canvas.Canvas(buf, pagesize=landscape(A4))
        c.setTitle(f"{report_label} — Canvas Guy Tracker")

        page_num = 1
        y = draw_header(c, report_label, subtitle, now_str, user_name, page_num)
        y = draw_section_bar(c, y, "CUSTOMER ORDERS")
        y = draw_col_headers(c, y, cols)

        row_idx = 0
        for row in rows:
            if y - ROW_H < BOTTOM:
                c.showPage()
                page_num += 1
                y = draw_header(c, report_label, subtitle, now_str, user_name, page_num)
                y = draw_section_bar(c, y, "CUSTOMER ORDERS (continued)")
                y = draw_col_headers(c, y, cols)
            y = draw_data_row(c, y, cols, row, row_idx)
            row_idx += 1

        if y - 10 * mm < BOTTOM:
            c.showPage()
            page_num += 1
            y = draw_header(c, report_label, subtitle, now_str, user_name, page_num)

        n          = len(customer_orders)
        total_val  = sum(float(o.get("total_value") or 0) for o in customer_orders)
        total_paid = sum(float(o.get("amount_paid") or 0) for o in customer_orders)
        total_bal  = max(total_val - total_paid, 0)
        left  = f"TOTAL  |  {n} order{'s' if n != 1 else ''}"
        right = (
            f"Total Value: KES {fmt_kes(total_val)}   "
            f"Collected: KES {fmt_kes(total_paid)}   "
            f"Outstanding: KES {fmt_kes(total_bal)}"
        )
        draw_totals(c, y - 2 * mm, left, right)
        c.save()
        return buf.getvalue()

    # ── Customer Statement branch (portrait A4) ───────────────────────────────
    customer_statement = data.get("customerStatement")
    if customer_statement is not None:
        cust    = customer_statement.get("customer", {})
        entries = customer_statement.get("entries", [])

        buf = io.BytesIO()
        c   = rl_canvas.Canvas(buf, pagesize=A4)
        c.setTitle(f"Statement — {cust.get('name', '')} — Canvas Guy Tracker")

        def draw_stmt_page(pg_num, first=False):
            """Draw portrait page header. Returns y for content start."""
            c.setFillColor(CORAL)
            c.rect(0, P_PH - 13*mm, P_PW, 13*mm, fill=1, stroke=0)
            c.setFillColor(WHITE)
            c.setFont("Helvetica-Bold", 10)
            c.drawString(P_M, P_PH - 8.5*mm, "CANVAS GUY LIMITED")
            c.setFont("Helvetica", 6.5)
            c.drawRightString(P_PW - P_M, P_PH - 7*mm,
                "Colorful Spaces  |  1408-01000 Thika  |  Holla@canvasguy.co.ke  |  0713-196-650")

            yy = P_PH - 21*mm
            c.setFillColor(DGRAY)
            c.setFont("Helvetica-Bold", 11)
            c.drawString(P_M, yy, "CUSTOMER STATEMENT")
            c.setFont("Helvetica", 7)
            c.drawRightString(P_PW - P_M, yy, f"{now_str}   |   Page {pg_num}")

            if subtitle:
                yy -= 4.5*mm
                c.setFont("Helvetica", 7)
                c.drawString(P_M, yy, subtitle)

            yy -= 5*mm
            c.setStrokeColor(MGRAY)
            c.setLineWidth(0.4)
            c.line(P_M, yy, P_PW - P_M, yy)

            if first:
                yy -= 3*mm
                box_h = 22*mm
                c.setFillColor(LGRAY)
                c.rect(P_M, yy - box_h, P_CW, box_h, fill=1, stroke=0)
                c.setFillColor(DGRAY)
                c.setFont("Helvetica-Bold", 8)
                c.drawString(P_M + 3*mm, yy - 5*mm, cust.get("name", "").upper())
                c.setFont("Helvetica", 6.5)
                info_rows = list(filter(None, [
                    cust.get("address"),
                    "  ·  ".join(filter(None, [cust.get("phone"), cust.get("email")])),
                    f"Terms: {cust['credit_terms']}" if cust.get("credit_terms") else None,
                    f"Prepared by: {user_name}" if user_name else None,
                ]))
                for li, line in enumerate(info_rows):
                    c.drawString(P_M + 3*mm, yy - 10*mm - li * 3.5*mm, line)
                yy -= box_h + 4*mm

            return yy - 2*mm

        def draw_stmt_col_headers(yy):
            c.setFillColor(DKROW)
            c.rect(P_M, yy - COL_HDR_H, P_CW, COL_HDR_H, fill=1, stroke=0)
            c.setFillColor(WHITE)
            c.setFont("Helvetica-Bold", 6.5)
            for col in CUSTOMER_STMT_COLS:
                cx = P_M + col["x"]
                if col.get("right"):
                    c.drawRightString(cx + col["w"] - 1.5*mm, yy - 4.8*mm, col["header"])
                else:
                    c.drawString(cx + 1.5*mm, yy - 4.8*mm, col["header"])
            return yy - COL_HDR_H

        def draw_stmt_row(yy, row, idx):
            c.setFillColor(LGRAY if idx % 2 == 0 else WHITE)
            c.rect(P_M, yy - ROW_H, P_CW, ROW_H, fill=1, stroke=0)
            c.setStrokeColor(MGRAY)
            c.setLineWidth(0.2)
            c.line(P_M, yy - ROW_H, P_M + P_CW, yy - ROW_H)
            for col in CUSTOMER_STMT_COLS:
                raw  = row.get(col["key"], "")
                text = str(raw) if raw else "—"
                fn   = "Helvetica-Bold" if col.get("bold") else "Helvetica"
                fs   = col.get("size", 6.5)
                limit = col["w"] - 3*mm
                while c.stringWidth(text, fn, fs) > limit and len(text) > 1:
                    text = text[:-2] + "…"
                c.setFillColor(DGRAY)
                c.setFont(fn, fs)
                cx = P_M + col["x"]
                if col.get("right"):
                    c.drawRightString(cx + col["w"] - 1.5*mm, yy - 4.5*mm, text)
                else:
                    c.drawString(cx + 1.5*mm, yy - 4.5*mm, text)
            return yy - ROW_H

        # Build rows
        stmt_rows = []
        for e in entries:
            debit  = float(e.get("debit")   or 0)
            credit = float(e.get("credit")  or 0)
            bal    = float(e.get("balance") or 0)
            stmt_rows.append({
                "date":        fmt_date(e.get("date")),
                "type":        e.get("type", ""),
                "description": e.get("description") or "—",
                "debit":       fmt_kes(debit)  if debit  > 0 else "—",
                "credit":      fmt_kes(credit) if credit > 0 else "—",
                "balance":     fmt_kes(abs(bal)) + (" CR" if bal < 0 else ""),
            })

        page_num = 1
        y = draw_stmt_page(page_num, first=True)

        # Section bar
        c.setFillColor(BLACK)
        c.rect(P_M, y - 7*mm, P_CW, 7*mm, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(P_M + 3*mm, y - 4.8*mm, "TRANSACTION HISTORY")
        y -= 7*mm

        y = draw_stmt_col_headers(y)

        row_idx = 0
        for row in stmt_rows:
            if y - ROW_H < P_BOTTOM:
                c.showPage()
                page_num += 1
                y = draw_stmt_page(page_num, first=False)
                y = draw_stmt_col_headers(y)
            y = draw_stmt_row(y, row, row_idx)
            row_idx += 1

        # Closing balance bar
        if y - 10*mm < P_BOTTOM:
            c.showPage()
            page_num += 1
            y = draw_stmt_page(page_num, first=False)

        final_bal = float(entries[-1].get("balance", 0)) if entries else 0
        bal_str   = fmt_kes(abs(final_bal)) + (" CR" if final_bal < 0 else "")
        n_entries = len(entries)
        c.setFillColor(CORAL)
        c.rect(P_M, y - 8*mm, P_CW, 8*mm, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(P_M + 3*mm, y - 5.5*mm,
                     f"CLOSING BALANCE  |  {n_entries} transaction{'s' if n_entries != 1 else ''}")
        c.drawRightString(P_PW - P_M - 2*mm, y - 5.5*mm, f"Balance: KES {bal_str}")

        c.save()
        return buf.getvalue()

    # ── Orders branch (production / financial reports) ─────────────────────────
    orders    = data.get("orders", [])
    all_items = data.get("allItems", {})
    pay_totals = data.get("payTotals", {})
    show_fin  = bool(data.get("showFinancials", False))
    workload  = data.get("workloadSummary") or []

    # ── Flatten orders → rows ──
    rows        = []
    total_units = 0

    for order in orders:
        oid   = order.get("id", "")
        items = all_items.get(oid, [])
        paid  = float(pay_totals.get(oid, 0) or 0)
        tv    = float(order.get("total_value") or 0)
        bal   = max(tv - paid, 0)

        if show_fin:
            rows.append({
                "client":    order.get("client", ""),
                "order_num": order.get("order_num", ""),
                "due_date":  fmt_date(order.get("due_date")),
                "status":    order.get("status", ""),
                "value":     fmt_kes(tv),
                "paid":      fmt_kes(paid),
                "balance":   fmt_kes(bal),
            })
            total_units += 1

        else:
            if not items:
                rows.append({
                    "client":      order.get("client", ""),
                    "order_num":   order.get("order_num", ""),
                    "due_date":    fmt_date(order.get("due_date")),
                    "status":      order.get("status", ""),
                    "category":    "—",
                    "description": order.get("items", "") or "—",
                    "qty":         "—",
                    "size":        "—",
                    "finish":      "—",
                    "wood":        "—",
                })
                total_units += 1
            else:
                for idx, item in enumerate(items):
                    qty = item.get("quantity") or 1
                    total_units += qty
                    finish = " / ".join(
                        filter(None, [item.get("finish_type"), item.get("finish_color")])
                    ) or "—"
                    rows.append({
                        "client":      order.get("client", "") if idx == 0 else "",
                        "order_num":   order.get("order_num", "") if idx == 0 else "",
                        "due_date":    fmt_date(order.get("due_date")) if idx == 0 else "",
                        "status":      order.get("status", "") if idx == 0 else "",
                        "category":    item.get("category") or "—",
                        "description": item.get("description") or "—",
                        "qty":         str(qty),
                        "size":        item.get("size") or "—",
                        "finish":      finish,
                        "wood":        item.get("wood_type") or "—",
                    })

    cols = FIN_COLS if show_fin else PROD_COLS

    # ── Draw ──
    buf   = io.BytesIO()
    c     = rl_canvas.Canvas(buf, pagesize=landscape(A4))
    c.setTitle(f"{report_label} Report — Canvas Guy Tracker")

    page_num = 1
    y = draw_header(c, f"{report_label} Report", subtitle, now_str, user_name, page_num)

    # Workload cards (first page only)
    if workload:
        y = draw_workload_cards(c, y, workload)

    y = draw_section_bar(c, y, "ORDER DETAILS")
    y = draw_col_headers(c, y, cols)

    row_idx = 0
    for row in rows:
        if y - ROW_H < BOTTOM:
            c.showPage()
            page_num += 1
            y = draw_header(c, f"{report_label} Report", subtitle, now_str, user_name, page_num)
            y = draw_section_bar(c, y, "ORDER DETAILS (continued)")
            y = draw_col_headers(c, y, cols)

        y = draw_data_row(c, y, cols, row, row_idx)
        row_idx += 1

    # ── Totals bar ──
    if y - 10 * mm < BOTTOM:
        c.showPage()
        page_num += 1
        y = draw_header(c, f"{report_label} Report", subtitle, now_str, user_name, page_num)

    n_orders = len(orders)
    left = f"TOTAL  |  {n_orders} order{'s' if n_orders != 1 else ''}  |  {total_units} units"

    if show_fin:
        total_val  = sum(float(o.get("total_value") or 0) for o in orders)
        total_paid = sum(float(pay_totals.get(o.get("id", ""), 0) or 0) for o in orders)
        total_bal  = max(total_val - total_paid, 0)
        right = (
            f"Value: KES {fmt_kes(total_val)}   "
            f"Collected: KES {fmt_kes(total_paid)}   "
            f"Outstanding: KES {fmt_kes(total_bal)}"
        )
        draw_totals(c, y - 2 * mm, left, right)
    else:
        draw_totals(c, y - 2 * mm, left)

    c.save()
    return buf.getvalue()


if __name__ == "__main__":
    raw  = sys.stdin.buffer.read()
    data = json.loads(raw)
    pdf  = build(data)
    sys.stdout.buffer.write(pdf)
