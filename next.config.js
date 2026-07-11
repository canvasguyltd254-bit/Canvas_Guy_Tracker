/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep pdfkit (and its deps) as native Node.js — webpack must not bundle them
  serverExternalPackages: ['pdfkit', 'fontkit', 'linebreak', 'unicode-properties', 'restructure'],
};

module.exports = nextConfig;
