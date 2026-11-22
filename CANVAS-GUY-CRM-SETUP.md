# Canvas Guy website -> CRM (tracker) setup (corrected)

The Custom Orders form posts to /apps/cg/enquiry (Shopify App Proxy), which Shopify
forwards to the tracker route /api/integrations/shopify/proxy/enquiry.
The normal Shopify contact email is still sent as a backup.

## 1. Tracker code
Branch `feature/canvas-guy-web-enquiries` (built on feature/production-module).
465 unit tests pass. No database migration needed: brand 'canvas_guy' is already accepted.
Merge it and let Vercel deploy BEFORE step 4.

## 2. Shopify (store 1sqyr0-xs.myshopify.com)
Create the app the same way the "TSC CRM Bridge" app was created (an app that offers the
App proxy setting; if Settings > Apps > Develop apps has no App proxy option, use the Dev Dashboard).
App proxy settings:
- Subpath prefix: `apps`
- Subpath: `cg`
- Proxy URL: `https://<tracker-domain>/api/integrations/shopify/proxy`
  (NO trailing slash and NO `/enquiry`: Shopify appends `/enquiry` itself.
  Writing `.../proxy/enquiry` makes the final path `.../enquiry/enquiry` and returns 404.)
Install the app and copy its client secret (API secret key). Keep it out of chat and git.
Use the stable production domain, not a per-deployment *.vercel.app URL, and make sure
Vercel Deployment Protection does not block Shopify.

## 3. Vercel env vars (Production)
Keep the existing Seating Company variables. Add, as ONE line:

SHOPIFY_PROXY_SHOPS=[{"shop":"1sqyr0-xs.myshopify.com","secret":"<Canvas Guy app secret>","brand":"canvas_guy"}]

Redeploy afterwards (env vars are only read at build time).

## 4. Theme
Upload canvas-guy-patch-v19.zip as an unpublished theme and test before publishing.

## 5. Tests before publishing
- Open https://www.canvasguy.co.ke/apps/cg/enquiry in a browser: expect 405 (not 404).
- Real enquiry arrives in the tracker's Enquiries tab with brand Canvas Guy; the email still arrives.
- Honeypot filled -> no CRM record, page still shows success.
- Same submission twice -> one CRM record.
- Consent unticked -> the browser blocks the submit.
- Unsigned POST to the tracker route -> 403/401, nothing created.
- Privacy policy updated to mention the CRM and source tracking.
