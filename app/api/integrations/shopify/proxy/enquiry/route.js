/**
 * POST /api/integrations/shopify/proxy/enquiry
 *
 * Receives the website enquiry form through a Shopify App Proxy
 * (storefront path /apps/tsc/enquiry → this route) and turns it into a CRM
 * enquiry. Machine-to-machine: there is NO user session here.
 *
 * Trust model: Shopify signs the proxy QUERY STRING (not the body) with the app
 * secret. A valid signature proves the request came through our shop's proxy;
 * it does not prove a real person filled in the form, because anyone can post
 * to the public storefront path. So we also: drop honeypot hits, validate every
 * field, cap body size, and the database rate-limits and de-duplicates.
 *
 * Env: SHOPIFY_APP_SECRET, SHOPIFY_SHOP_DOMAIN (e.g. the-seating-company.myshopify.com),
 *      SHOPIFY_FORM_BRAND (optional, default 'seating_company').
 *
 * Always answers JSON. Never echoes submitted data back, never logs the payload.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { serviceClient } from '@/shared/lib/api-auth';
import { verifyProxySignature, parseEnquiryFields, buildDescription, CONSENT_VERSION } from '@/shared/lib/shopifyEnquiry';

const MAX_BODY_BYTES = 20 * 1024;
const BRANDS = ['canvas_guy', 'seating_company'];

const fail = (status, error) => NextResponse.json({ ok: false, error }, { status });

export async function POST(request) {
  try {
    const secret = process.env.SHOPIFY_APP_SECRET;
    const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    if (!secret || !shopDomain) {
      console.error('shopify enquiry: SHOPIFY_APP_SECRET / SHOPIFY_SHOP_DOMAIN not configured — refusing');
      return fail(503, 'Not configured');
    }

    const params = new URL(request.url).searchParams;
    if (!verifyProxySignature(params, secret)) return fail(401, 'Invalid signature');
    if (params.get('shop') !== shopDomain) return fail(403, 'Unknown shop');

    const declared = parseInt(request.headers.get('content-length') || '0', 10);
    if (declared > MAX_BODY_BYTES) return fail(413, 'Request too large');

    const fields = {};
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return fail(413, 'Request too large');
      let json;
      try { json = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON'); }
      for (const [k, v] of Object.entries(json || {})) if (typeof v === 'string' || typeof v === 'number') fields[k] = String(v);
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) if (typeof v === 'string') fields[k] = v;
    }

    const parsed = parseEnquiryFields(fields);
    if (!parsed.ok) return fail(400, parsed.errors.join(' '));
    // Honeypot: look successful to the bot, create nothing.
    if (parsed.spam) return NextResponse.json({ ok: true });

    const v = parsed.value;
    const brand = BRANDS.includes(process.env.SHOPIFY_FORM_BRAND) ? process.env.SHOPIFY_FORM_BRAND : 'seating_company';

    const { data, error } = await serviceClient.rpc('create_enquiry_from_web_form', {
      p_provider: 'shopify',
      p_shop_domain: shopDomain,
      p_external_id: v.submissionId,
      p_brand: brand,
      p_name: v.name,
      p_phone: v.phone,
      p_email: v.email,
      p_category: v.productInterest || null,
      p_description: buildDescription(v),
      p_payload: {
        project_type: v.projectType, product_interest: v.productInterest, quantity: v.quantity,
        budget: v.budget, reference_link: v.referenceLink, company: v.company, location: v.location,
        attribution: v.attribution,
        consent: { given: true, version: CONSENT_VERSION, at: new Date().toISOString() },
      },
    });

    if (error) {
      const code = String(error.message || '').trim();
      if (code === 'RATE_LIMITED') return fail(429, 'Too many requests');
      if (code === 'BAD_INPUT') return fail(400, 'Invalid submission');
      console.error('shopify enquiry: rpc failed:', error.code, code);
      return fail(500, 'Could not save the enquiry');
    }

    return NextResponse.json({ ok: true, reference: data?.enq_num || null, duplicate: !!data?.duplicate });
  } catch (err) {
    console.error('POST /api/integrations/shopify/proxy/enquiry:', err?.message);
    return fail(500, 'Internal server error');
  }
}
