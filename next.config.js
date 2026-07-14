/** @type {import('next').NextConfig} */

// pdfkit and its full runtime dependency tree.
// These are spawned as a child process so Vercel's file tracer cannot
// discover them via static analysis — they must be declared explicitly.
// Use recursive /**/* globs so both files and subdirectories are captured.
const PDFKIT_MODULES = [
  // pdfkit itself
  './node_modules/pdfkit/**/*',
  // pdfkit direct deps
  './node_modules/@noble/ciphers/**/*',
  './node_modules/@noble/hashes/**/*',
  './node_modules/fontkit/**/*',
  './node_modules/js-md5/**/*',
  './node_modules/linebreak/**/*',
  './node_modules/png-js/**/*',
  // fontkit transitive deps
  './node_modules/@swc/helpers/**/*',
  './node_modules/brotli/**/*',
  './node_modules/clone/**/*',
  './node_modules/dfa/**/*',
  './node_modules/fast-deep-equal/**/*',
  './node_modules/restructure/**/*',
  './node_modules/tiny-inflate/**/*',
  './node_modules/unicode-properties/**/*',
  './node_modules/unicode-trie/**/*',
  // deeper transitive deps
  './node_modules/base64-js/**/*',
  './node_modules/browserify-zlib/**/*',
  './node_modules/pako/**/*',
  // @swc/helpers (fontkit's nested copy) resolves these from top-level node_modules
  './node_modules/tslib/**/*',
  './node_modules/@swc/counter/**/*',
];

const PDF_ROUTES_INCLUDES = [
  './scripts/**/*',
  './public/canvas-guy-logo.png',
  ...PDFKIT_MODULES,
];

const nextConfig = {
  reactStrictMode: true,
  // Tell Vercel's file tracer to include scripts/ + the entire pdfkit module
  // tree. Without this the child process cannot find pdfkit at runtime because
  // the tracer never sees a static import of it.
  // Note: serverExternalPackages is not needed — pdfkit is never imported by
  // the route files directly, so webpack never attempts to bundle it.
  experimental: {
    outputFileTracingIncludes: {
      '/api/reports/pdf':                   PDF_ROUTES_INCLUDES,
      '/api/orders/[id]/delivery-note/pdf': PDF_ROUTES_INCLUDES,
    },
  },
};

module.exports = nextConfig;
