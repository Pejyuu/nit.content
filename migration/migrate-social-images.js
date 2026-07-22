#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const matter = require('../workbench/node_modules/gray-matter');
const yaml = require('../workbench/node_modules/js-yaml');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_REPO = path.join(ROOT, 'content-repo');
const LEGACY_MEDIA = path.join(ROOT, 'content', 'media');
const REPORT_FILE = path.join(__dirname, 'reports', 'social-image-migration.json');

function walk(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, result);
    else if (entry.name === 'index.md') result.push(full);
  }
  return result.sort();
}

function splitSource(raw) {
  const delimiter = /^---[ \t]*(?:\r?\n|$)/gm;
  const first = delimiter.exec(raw);
  const second = delimiter.exec(raw);
  if (!first || first.index !== 0 || !second) throw new Error('missing YAML frontmatter delimiters');
  return {
    body: raw.slice(second.index + second[0].length),
    eol: first[0].endsWith('\r\n') ? '\r\n' : '\n'
  };
}

function parse(raw) {
  return matter(raw, { engines: { yaml: source => yaml.load(source, { schema: yaml.JSON_SCHEMA }) } });
}

function serialize(data, body, eol) {
  const frontmatter = yaml.dump(data, { noRefs: true, lineWidth: 1000, quotingType: "'", sortKeys: false }).replace(/\n/g, eol);
  return `---${eol}${frontmatter}---${eol}${body}`;
}

function legacySource(reference) {
  if (!reference || typeof reference !== 'string') return null;
  const candidate = path.join(LEGACY_MEDIA, path.basename(reference.replace(/\\/g, '/')));
  return fs.existsSync(candidate) ? candidate : null;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyExact(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination) || digest(source) !== digest(destination)) fs.copyFileSync(source, destination);
  if (digest(source) !== digest(destination)) throw new Error(`copy verification failed: ${destination}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  migrated: [],
  noLegacySocialImage: [],
  missingSource: [],
  placeholders: []
};

for (const file of walk(CONTENT_REPO)) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parse(raw);
  const sourceParts = splitSource(raw);
  const data = parsed.data;
  const ogReference = data.sharing?.og_image;
  const twitterReference = data.sharing?.twitter_image;
  const ogSource = legacySource(ogReference);
  const twitterSource = legacySource(twitterReference);
  const rel = path.relative(ROOT, file).split(path.sep).join('/');

  if (ogReference && !ogSource) report.missingSource.push({ path: rel, field: 'sharing.og_image', reference: ogReference });
  if (twitterReference && !twitterSource) report.missingSource.push({ path: rel, field: 'sharing.twitter_image', reference: twitterReference });
  if (!ogSource && !twitterSource) {
    report.noLegacySocialImage.push(rel);
    continue;
  }

  const socialDirectory = path.join(path.dirname(file), 'social');
  fs.mkdirSync(socialDirectory, { recursive: true });
  data.images = data.images && typeof data.images === 'object' ? data.images : {};
  data.images.social = data.images.social && typeof data.images.social === 'object' ? data.images.social : {};
  const copied = {};

  if (ogSource) {
    const filename = `universal${path.extname(ogSource).toLowerCase()}`;
    copyExact(ogSource, path.join(socialDirectory, filename));
    data.images.social.universal = `social/${filename}`;
    copied.universal = { file: `social/${filename}`, sha256: digest(ogSource), legacyReference: ogReference };
    if (/placeholder/i.test(path.basename(ogSource))) report.placeholders.push({ path: rel, field: 'images.social.universal', file: `social/${filename}` });
  }

  if (twitterSource) {
    if (ogSource && digest(twitterSource) === digest(ogSource)) {
      data.images.social.twitter = data.images.social.universal;
      copied.twitter = { file: data.images.social.universal, sha256: digest(twitterSource), legacyReference: twitterReference, sharedWithUniversal: true };
    } else {
      const filename = `twitter${path.extname(twitterSource).toLowerCase()}`;
      copyExact(twitterSource, path.join(socialDirectory, filename));
      data.images.social.twitter = `social/${filename}`;
      copied.twitter = { file: `social/${filename}`, sha256: digest(twitterSource), legacyReference: twitterReference };
    }
  }

  const output = serialize(data, sourceParts.body, sourceParts.eol);
  if (!output.endsWith(sourceParts.body)) throw new Error(`body preservation failed: ${rel}`);
  fs.writeFileSync(file, output, 'utf8');
  report.migrated.push({ path: rel, copied });
}

fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`social images: ${report.migrated.length} bundles migrated; ${report.missingSource.length} missing sources; ${report.placeholders.length} placeholders`);
