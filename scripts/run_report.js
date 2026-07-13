'use strict';
/**
 * scripts/run_report.js
 *
 * Stdin → stdout bridge for PDF generation.
 * Called by app/api/reports/pdf/route.js via child_process.spawn so that
 * pdfkit runs in a plain Node.js process — completely outside webpack's
 * module graph and bundling pipeline.
 *
 * Input  : JSON-encoded report data on stdin
 * Output : raw PDF bytes on stdout
 * Exit 1 : error message on stderr
 */
const { buildReportPDF } = require('./build_report.js');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write('run_report: invalid JSON — ' + e.message);
    process.exit(1);
  }

  buildReportPDF(data)
    .then(buf => {
      process.stdout.write(buf);
      process.exit(0);
    })
    .catch(err => {
      process.stderr.write(err?.message || String(err));
      process.exit(1);
    });
});
