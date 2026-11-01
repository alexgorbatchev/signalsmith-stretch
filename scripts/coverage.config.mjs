import {readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = new Set(readdirSync(join(root, 'web'))
  .filter(name => name.endsWith('.js')).map(name => join(root, 'web', name)));

export default {
  baseDir: root,
  outputDir: join(root, '.tmp/coverage'),
  cleanCache: true,
  reports: ['console-details', 'v8-json', 'json-summary'],
  entryFilter: entry => sources.has(entry.url.startsWith('file:')
    ? fileURLToPath(entry.url) : entry.url),
  all: {dir: join(root, 'web'), filter: file => sources.has(file)},
  onEnd(results) {
    if (!sources.size || !results || !Array.isArray(results.files) || results.files.length !== sources.size) {
      throw new Error('Coverage must include every first-party web source');
    }
    const expected = new Set([...sources].map(file => relative(root, file).replaceAll('\\', '/')));
    const failures = [];
    for (const file of results.files) {
      if (!expected.delete(file.sourcePath)) {
        throw new Error(`Unexpected or duplicate coverage source: ${file.sourcePath}`);
      }
      for (const metric of ['lines', 'functions']) {
        const summary = file.summary?.[metric];
        if (!summary || !Number.isFinite(summary.pct) || summary.pct < 90) {
          failures.push(`${file.sourcePath} ${metric}: ${summary?.pct ?? 'missing'}%, required 90%`);
        }
      }
    }
    if (expected.size || failures.length) {
      throw new Error([...expected].concat(failures).join('\n'));
    }
  }
};
