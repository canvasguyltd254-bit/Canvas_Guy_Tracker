/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep pdfkit (and its deps) as native Node.js — webpack must not bundle them
  serverExternalPackages: ['pdfkit', 'fontkit', 'linebreak', 'unicode-properties', 'restructure'],
  // Tell Vercel's file tracer to include the scripts/ directory.
  // Without this, build_report.js and pdfkit.standalone.js are excluded from
  // the deployment because they're referenced as path strings, not imports.
  experimental: {
    outputFileTracingIncludes: {
      '/api/reports/pdf': ['./scripts/**'],
    },
  },
};

module.exports = nextConfig;
