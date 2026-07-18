#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('../workbench/node_modules/gray-matter');
const yaml = require('../workbench/node_modules/js-yaml');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'content-repo');
const overrides = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'classification-overrides.json'), 'utf8'));

function slash(value) { return value.split(path.sep).join('/'); }
function stableKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function ensure(directory) { fs.mkdirSync(directory, { recursive: true }); }
function copy(source, destination) { ensure(path.dirname(destination)); fs.copyFileSync(source, destination); }
function parse(file) {
  return matter(fs.readFileSync(file, 'utf8'), { engines: { yaml: source => yaml.load(source, { schema: yaml.JSON_SCHEMA }) } });
}
function markdownFiles(directory) {
  const result = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.mdx?$/i.test(entry.name)) result.push(full);
    }
  }
  walk(directory);
  return result.sort();
}
function coverSource(data) {
  const value = data.cover || data.images?.cover;
  if (typeof value !== 'string') return null;
  const filename = path.basename(value.replace(/\\/g, '/'));
  const candidate = path.join(ROOT, 'content', 'media', filename);
  return fs.existsSync(candidate) ? candidate : null;
}
function writePlaceholder(directory) {
  ensure(directory);
  const marker = path.join(directory, '.gitkeep');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, '', 'utf8');
}

if (fs.existsSync(TARGET) && fs.readdirSync(TARGET).length) {
  throw new Error('content-repo already exists and is not empty; refusing to overwrite it');
}

for (const directory of ['candidates/rejected', 'posts', 'guides', 'visas', 'taxonomies', 'authors']) ensure(path.join(TARGET, directory));

for (const file of markdownFiles(path.join(ROOT, 'pipeline'))) {
  const parsed = parse(file);
  const rejected = parsed.data.pipeline?.stage === 'archived';
  const destination = path.join(TARGET, 'candidates', rejected ? 'rejected' : '', `${path.basename(file, path.extname(file))}.md`);
  copy(file, destination);
}

for (const file of markdownFiles(path.join(ROOT, 'content', 'posts'))) {
  const parsed = parse(file);
  const rel = slash(path.relative(path.join(ROOT, 'content', 'posts'), file));
  const parts = rel.split('/');
  const year = parts[0];
  const month = parts[1];
  const key = stableKey(parsed.data.slug || path.basename(file, path.extname(file)).replace(/^\d{4}-\d{2}-\d{2}-?/, ''));
  const bundle = path.join(TARGET, 'posts', year, month, key);
  copy(file, path.join(bundle, 'index.md'));
  const cover = coverSource(parsed.data);
  if (cover) copy(cover, path.join(bundle, `cover${path.extname(cover).toLowerCase()}`));
  writePlaceholder(path.join(bundle, 'social'));
}

for (const base of ['guides', 'docs']) for (const file of markdownFiles(path.join(ROOT, 'content', base))) {
  const legacyRel = slash(path.relative(ROOT, file));
  const type = base === 'guides' ? 'guide' : overrides[legacyRel];
  if (type !== 'guide' && type !== 'visa') continue;
  const parsed = parse(file);
  const key = stableKey(parsed.data.slug || path.basename(file, path.extname(file)));
  const collection = type === 'guide' ? 'guides' : 'visas';
  const bundle = path.join(TARGET, collection, key);
  copy(file, path.join(bundle, 'index.md'));
  const cover = coverSource(parsed.data);
  if (cover) copy(cover, path.join(bundle, `cover${path.extname(cover).toLowerCase()}`));
  writePlaceholder(path.join(bundle, type === 'guide' ? 'illustrations' : 'documents'));
}

const taxonomy = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'taxonomy.json'), 'utf8'));
const taxonomyFiles = {
  'topics.json': { values: taxonomy.topics, aliases: taxonomy.aliases },
  'audiences.json': { values: [] },
  'post-categories.json': { values: taxonomy.categories },
  'guide-sections.json': { values: taxonomy.sections },
  'visa-categories.json': { values: taxonomy.visaCategories }
};
for (const [name, value] of Object.entries(taxonomyFiles)) {
  fs.writeFileSync(path.join(TARGET, 'taxonomies', name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const oldAuthor = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', '_data', 'authors', 'marianne-h.json'), 'utf8'));
const author = { id: 'author.marianne', name: oldAuthor.aname, slug: oldAuthor.slug, bio: oldAuthor.bio, link: oldAuthor.link, profilePhoto: oldAuthor.profile_photo };
fs.writeFileSync(path.join(TARGET, 'authors', 'marianne.json'), `${JSON.stringify(author, null, 2)}\n`, 'utf8');

console.log('content-repo materialized without changing legacy content');
