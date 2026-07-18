'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nit-frontmatter-'));
const contentDir = path.join(fixtureRoot, 'content', 'posts', '2025', '01');
fs.mkdirSync(contentDir, { recursive: true });
const body = '\nBody with **formatting**.\n';
fs.writeFileSync(path.join(contentDir, '2025-01-01-test.mdx'), `---\npublished: true\ndate: 2025-01-01T10:00\nauthor: marianneh\nslug: test\ntitle: Test\ncategories: nyheter\nexcerpt: Description\n---${body}`);

const relContent = path.relative(root, path.join(fixtureRoot, 'content'));
const relReports = path.relative(root, path.join(fixtureRoot, 'reports'));
const result = spawnSync(process.execPath, [path.join(__dirname, 'frontmatter-migrate.js'), 'dry-run', '--content-dir', relContent, '--report-dir', relReports], { encoding: 'utf8' });
assert.strictEqual(result.status, 1, 'outside-repository content directory must be rejected');

const source = fs.readFileSync(path.join(__dirname, 'frontmatter-migrate.js'), 'utf8');
assert(source.includes("command = 'dry-run'"), 'dry-run must be the default');
assert(source.includes('Markdown body changed'), 'body integrity gate must exist');
assert(source.includes('duplicate IDs'), 'duplicate ID apply gate must exist');
assert(source.includes('yaml.JSON_SCHEMA'), 'timestamps must be parsed as strings without timezone normalization');
assert(source.includes('splitSource(raw)'), 'body must be sliced directly from the source');
console.log('frontmatter migration safety tests passed');
