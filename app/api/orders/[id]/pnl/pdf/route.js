/**
 * app/api/orders/[id]/pnl/pdf/route.js
 *
 * GET /api/orders/:id/pnl/pdf
 *
 * Generates a single-order P&L PDF — order info, KPI summary, revenue
 * breakdown, and linked supplier costs — as a portrait A4 document.
 *
 * Allowed roles: admin, production_manager, head_of_sales
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { spawn } from 'child_process';
import { join } from 'path';

const CHARGE_CATS = new Set(['Delivery Fee', 'Installation Fee', 'Design Fee', 'Rush Fee', 'Discount']);

function spawnPdf(data) {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), 'scripts', 'run_report.js');
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('close', code => {
      if (code !== 0) reject(new Error(Buffer.concat(err).toString() || 'PDF generation failed'));
      else            resolve(Buffer.concat(out));
    });
    child.on('error', e => reject(new Error(`Failed to spawn PDF process: ${e.message}`)));
    child.stdin.write(JSON.stringify(data), 'utf8');
    child.stdin.end();
  });
}

export async function GET(request, { params }) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales']);
    if (authError) return authError;

    const orderId = params.id;

    // ── Fetch order ─────────────────────────────────────────────────────────
    const { data: order, error: orderErr } = await serviceClient
      .from('orders')
      .select('id, order_num, client, status, total_value, due_date, created_at')
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // ── Fetch order items (for revenue breakdown) ─────────────────────────
    const { data: allItems, error: itemsErr } = await serviceClient
      .from('order_items')
      .select('id, category, description, unit_price, quantity, sort_order')
      .eq('order_id', orderId)
      .order('sort_order');

    if (itemsErr) {
      console.error('GET /api/orders/[id]/pnl/pdf — items fetch error:', itemsErr.message);
      return NextResponse.json({ error: 'Failed to fetch order items' }, { status: 500 });
    }

    const items        = allItems || [];
    const chargeItems  = items.filter(i =>  CHARGE_CATS.has(i.category));
    const regularItems = items.filter(i => !CHARGE_CATS.has(i.category));
    const itemsSubtotal = regularItems.reduce((s, i) =>
      s + (parseFloat(i.unit_price) || 0) * (parseInt(i.quantity) || 1), 0);

    // ── Fetch payments ───────────────────────────────────────────────────
    const { data: payments, error: paymentsErr } = await serviceClient
      .from('order_payments')
      .select('id, amount, payment_date, description, reversed_at')
      .eq('order_id', orderId)
      .order('payment_date');

    if (paymentsErr) {
      console.error('GET /api/orders/[id]/pnl/pdf — payments fetch error:', paymentsErr.message);
      return NextResponse.json({ error: 'Failed to fetch payments' }, { status: 500 });
    }

    // Reversed payments no longer count as received — the reversal journal
    // already backs the receipt out in the GL.
    const totalPaid = (payments || []).filter(p => !p.reversed_at).reduce((s, p) => s + parseFloat(p.amount || 0), 0);

    // ── Fetch linked supplier purchases via purchase_order_links ─────────
    const { data: links, error: linksErr } = await serviceClient
      .from('purchase_order_links')
      .select(`
        purchase_id,
        amount,
        supplier_purchases (
          id,
          purchase_date,
          items_bought,
          total_amount,
          suppliers ( id, name )
        )
      `)
      .eq('order_id', orderId);

    if (linksErr) {
      console.error('GET /api/orders/[id]/pnl/pdf — links fetch error:', linksErr.message);
      return NextResponse.json({ error: 'Failed to fetch purchase links' }, { status: 500 });
    }

    // Determine link count per purchase (to flag unallocated multi-order shares)
    const purchaseIds = (links || []).map(l => l.purchase_id).filter(Boolean);
    const linkCountByPurchase = {};
    if (purchaseIds.length > 0) {
      const { data: allLinks, error: allLinksErr } = await serviceClient
        .from('purchase_order_links')
        .select('purchase_id')
        .in('purchase_id', purchaseIds);
      if (allLinksErr) {
        // Non-fatal: cost figures are unaffected; the unallocated warning may show false positives
        console.error('GET /api/orders/[id]/pnl/pdf — allLinks count error:', allLinksErr.message);
      } else {
        (allLinks || []).forEach(l => {
          linkCountByPurchase[l.purchase_id] = (linkCountByPurchase[l.purchase_id] || 0) + 1;
        });
      }
    }

    const purchases = (links || [])
      .filter(l => l.supplier_purchases)
      .map(l => {
        const p             = l.supplier_purchases;
        const purchaseTotal = parseFloat(p.total_amount || 0);
        const isUnallocated = l.amount == null && (linkCountByPurchase[l.purchase_id] || 1) > 1;
        const allocatedAmt  = l.amount == null ? purchaseTotal : parseFloat(l.amount);
        return {
          id:               p.id,
          purchase_date:    p.purchase_date,
          items_bought:     p.items_bought,
          total_amount:     allocatedAmt,
          purchase_total:   purchaseTotal,
          allocated_amount: l.amount == null ? null : allocatedAmt,
          is_unallocated:   isUnallocated,
          supplier:         p.suppliers ? { name: p.suppliers.name } : null,
        };
      });

    // ── Fetch skilled-labour allocations ─────────────────────────────────
    const { data: labourRows, error: labourErr } = await serviceClient
      .from('payroll_order_allocations')
      .select(`
        id, allocated_amount, notes,
        payroll_entries ( id, snapshot_name,
          payroll_runs ( run_num, period_start, period_end )
        )
      `)
      .eq('order_id', orderId)
      .order('created_at');

    if (labourErr) {
      console.error('GET /api/orders/[id]/pnl/pdf — labour fetch error:', labourErr.message);
      return NextResponse.json({ error: 'Failed to fetch labour cost data' }, { status: 500 });
    }

    const labourAllocations = (labourRows || []).map(row => ({
      id:               row.id,
      allocated_amount: parseFloat(row.allocated_amount || 0),
      notes:            row.notes,
      worker_name:      row.payroll_entries?.snapshot_name || '—',
      run_num:          row.payroll_entries?.payroll_runs?.run_num,
    }));

    // ── Fetch direct expenses allocated to this order ─────────────────────
    const { data: expLinks, error: expErr } = await serviceClient
      .from('order_direct_expense_links')
      .select(`
        allocated_amount,
        order_direct_expenses (
          id, expense_date, category, description, amount, reversed_at
        )
      `)
      .eq('order_id', orderId);

    if (expErr) {
      console.error('GET /api/orders/[id]/pnl/pdf — expenses fetch error:', expErr.message);
      return NextResponse.json({ error: 'Failed to fetch direct expenses' }, { status: 500 });
    }

    const directExpenses = (expLinks || [])
      .filter(l => l.order_direct_expenses && !l.order_direct_expenses.reversed_at)
      .map(l => ({
        ...l.order_direct_expenses,
        allocated_amount: parseFloat(l.allocated_amount),
      }));

    const totalPurchaseCost   = purchases.reduce((s, p) => s + p.total_amount, 0);
    const totalLabourCost     = labourAllocations.reduce((s, l) => s + l.allocated_amount, 0);
    const totalDirectExpenses = directExpenses.reduce((s, e) => s + e.allocated_amount, 0);
    const totalCost           = totalPurchaseCost + totalLabourCost + totalDirectExpenses;
    const contractTotal       = parseFloat(order.total_value || 0);
    const grossProfit         = contractTotal - totalPurchaseCost - totalLabourCost;
    const orderProfit         = grossProfit - totalDirectExpenses;
    const margin              = contractTotal > 0 ? (orderProfit / contractTotal) * 100 : 0;
    const outstanding         = Math.max(0, contractTotal - totalPaid);
    const hasUnallocated      = purchases.some(p => p.is_unallocated);

    // ── Build and return PDF ─────────────────────────────────────────────
    const pdfData = {
      singleOrderPnL: {
        order,
        purchases,
        labourAllocations,
        directExpenses,
        payments: payments || [],
        chargeItems,
        itemsSubtotal,
        hasUnallocated,
        totals: {
          contractTotal,
          totalPurchaseCost,
          totalLabourCost,
          totalDirectExpenses,
          totalCost,
          grossProfit,
          orderProfit,
          margin,
          totalPaid,
          outstanding,
        },
        userName: displayName,
      },
    };

    let pdfBuffer;
    try {
      pdfBuffer = await spawnPdf(pdfData);
    } catch (err) {
      const detail = err?.message || String(err);
      console.error('GET /api/orders/[id]/pnl/pdf — spawnPdf error:', detail);
      return NextResponse.json({ error: 'PDF generation failed', detail }, { status: 500 });
    }

    const filename = `${order.order_num || orderId}_PnL.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    const detail = err?.message || String(err);
    console.error('GET /api/orders/[id]/pnl/pdf — unexpected error:', detail);
    return NextResponse.json({ error: 'Internal server error', detail }, { status: 500 });
  }
}
