#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const matter = require('../workbench/node_modules/gray-matter');
const yaml = require('../workbench/node_modules/js-yaml');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(__dirname, 'config');
const REPORT_CATEGORIES = [
  'migrated', 'unchanged', 'needs-classification', 'needs-topic-mapping',
  'needs-source-review', 'needs-date-review', 'needs-author-review',
  'ambiguous-ad-zone', 'broken-relation', 'invalid-frontmatter'
];
const PUBLISHABLE = new Set(['post', 'guide', 'visa']);
const EXCLUDED = new Set(['singleton', 'topic-hub', 'redirect', 'archive-candidate', 'unresolved']);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function slash(value) { return value.split(path.sep).join('/'); }
function relative(file) { return slash(path.relative(ROOT, file)); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function asArray(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function nonEmpty(value) { return value !== undefined && value !== null && value !== ''; }
function stableKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function bodyHash(body) { return crypto.createHash('sha256').update(body).digest('hex'); }
function parseMatter(raw) {
  return matter(raw, { engines: { yaml: source => yaml.load(source, { schema: yaml.JSON_SCHEMA }) } });
}
function splitSource(raw) {
  const delimiter = /^---[ \t]*(?:\r?\n|$)/gm;
  const first = delimiter.exec(raw);
  const second = delimiter.exec(raw);
  if (!first || first.index !== 0 || !second) throw new Error('missing YAML frontmatter delimiters');
  const firstEol = first[0].endsWith('\r\n') ? '\r\n' : '\n';
  return { body: raw.slice(second.index + second[0].length), eol: firstEol };
}
function setIfMissing(object, key, value) {
  if (!nonEmpty(object[key]) && nonEmpty(value)) object[key] = value;
}
function nestedSetIfMissing(object, group, key, value) {
  if (!nonEmpty(value)) return;
  if (!object[group] || typeof object[group] !== 'object' || Array.isArray(object[group])) object[group] = {};
  setIfMissing(object[group], key, value);
}

function parseArgs(argv) {
  const args = [...argv];
  const known = new Set(['inventory', 'dry-run', 'apply', 'validate']);
  let command = 'dry-run';
  if (args[0] && known.has(args[0])) command = args.shift();
  const options = { contentDir: 'content-repo', reportDir: 'migration/reports', branch: null };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--content-dir') options.contentDir = args.shift();
    else if (flag === '--report-dir') options.reportDir = args.shift();
    else if (flag === '--branch') options.branch = args.shift();
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return { command, options };
}

function resolveInsideRoot(candidate, label) {
  const resolved = path.resolve(ROOT, candidate);
  const rel = path.relative(ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${label} must be inside the repository`);
  return resolved;
}

function filesUnder(directory) {
  const found = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.mdx?$/i.test(entry.name)) found.push(full);
    }
  }
  walk(directory);
  return found.sort();
}

function classify(rel, data, overrides) {
  if (overrides[rel]) return { type: overrides[rel], confidence: 'high', reason: 'classification override' };
  if (/^content-repo\/candidates\/rejected\//.test(rel)) return { type: 'archive-candidate', confidence: 'high', reason: 'rejected or archived workflow candidate' };
  if (/^content-repo\/candidates\//.test(rel)) return { type: 'unresolved', confidence: 'high', reason: 'workflow candidate not approved for publication' };
  if (/^(content|content-repo)\/posts\//.test(rel)) return { type: 'post', confidence: 'high', reason: 'dated editorial collection' };
  if (/^(content|content-repo)\/guides\//.test(rel)) return { type: 'guide', confidence: 'high', reason: 'maintained practical guide collection' };
  if (/^content-repo\/visas\//.test(rel)) return { type: 'visa', confidence: 'high', reason: 'formal visa collection' };
  if (/^(content|content-repo)\/pages\//.test(rel)) return { type: 'singleton', confidence: 'high', reason: 'static page collection' };
  if (PUBLISHABLE.has(data.type)) return { type: data.type, confidence: 'high', reason: 'existing valid type' };
  return { type: 'unresolved', confidence: 'low', reason: 'manual editorial classification required' };
}

function currentUrl(rel, data, type) {
  if (!data.slug) return null;
  if (type === 'post') return `/magasin/${data.categories || data.category || ''}/${data.slug}/`.replace(/\/+/g, '/');
  if (type === 'singleton') return `/${data.slug}/`;
  return `/visumguiden/${data.slug}/`;
}

function assetsFor(file, data, body) {
  const values = [];
  for (const value of [data.cover, data.images?.cover, data.sharing?.og_image]) if (typeof value === 'string') values.push(value);
  const imagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of body.matchAll(imagePattern)) values.push(match[1]);
  const siblingDir = path.dirname(file);
  for (const entry of fs.readdirSync(siblingDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(entry.name)) values.push(entry.name);
  }
  return unique(values);
}

function makeId(type, rel, data) {
  const key = stableKey(data.slug || path.basename(rel, path.extname(rel)).replace(/^\d{4}-\d{2}-\d{2}-?/, ''));
  if (!key) return null;
  if (type === 'post') {
    const match = rel.match(/(?:^|\/)(20\d{2})(?:\/|-)/);
    const year = match ? match[1] : String(data.date || data.publishedAt || '').slice(0, 4);
    return /^20\d{2}$/.test(year) ? `post.${year}.${key}` : null;
  }
  return `${type}.${key}`;
}

function sourceId(source, index) {
  const url = typeof source === 'string' ? source : source?.url;
  if (url) {
    try {
      const parsed = new URL(url);
      const key = stableKey(`${parsed.hostname.replace(/^www\./, '')}-${parsed.pathname}`);
      if (key) return `source.${key.slice(0, 80)}`;
    } catch (_) {}
  }
  return `source.unresolved-${index + 1}`;
}

function convertSources(sources) {
  return asArray(sources).map((source, index) => {
    if (source && typeof source === 'object' && source.id && Object.hasOwn(source, 'sourceType')) return source;
    const old = typeof source === 'string' ? { url: source } : (source || {});
    return {
      id: old.id || sourceId(old, index), title: old.title ?? null, publisher: old.publisher ?? null,
      url: old.url ?? null, sourceType: old.sourceType || 'unclassified', publishedAt: old.publishedAt ?? null,
      accessedAt: old.accessedAt ?? null, supports: asArray(old.supports), archivedUrl: old.archivedUrl ?? null,
      note: old.note ?? null
    };
  });
}

function transform(rel, parsed, classification, manifest, taxonomy) {
  const before = parsed.data;
  const data = JSON.parse(JSON.stringify(before));
  const issues = [];
  const unknown = [];
  const type = classification.type;
  if (!PUBLISHABLE.has(type)) return { data, issues, unknown, changed: false };

  setIfMissing(data, 'type', type);
  setIfMissing(data, 'id', manifest[rel] || makeId(type, rel, data));
  if (!data.id) issues.push('needs-date-review');
  if (!manifest[rel] && data.id) manifest[rel] = data.id;
  setIfMissing(data, 'description', data.excerpt || data.seo?.description);
  if (!data.description) issues.push('needs-date-review');
  setIfMissing(data, 'stage', data.pipeline?.stage);
  if (!data.stage) data.stage = data.published === true ? 'published' : 'draft';
  if (!data.status) data.status = type === 'post' ? (data.published === true ? 'published' : 'draft') : 'needs-review';
  setIfMissing(data, 'createdAt', data.created);
  setIfMissing(data, 'updatedAt', data.updated);
  if (type === 'post') {
    setIfMissing(data, 'publishedAt', data.published_date || data.date);
    setIfMissing(data, 'category', Array.isArray(data.categories) ? data.categories[0] : data.categories);
    if (!data.publishedAt) issues.push('needs-date-review');
  } else {
    if (!Object.hasOwn(data, 'lastVerifiedAt')) data.lastVerifiedAt = null;
    if (!Object.hasOwn(data, 'nextReviewAt')) data.nextReviewAt = null;
    if (!Array.isArray(data.revisionHistory)) data.revisionHistory = [];
    if (!data.lastVerifiedAt) issues.push('needs-date-review');
  }
  if (!data.author) issues.push('needs-author-review');

  const mappedTopics = [];
  for (const tag of asArray(data.tags)) {
    const normalized = stableKey(tag);
    const mapped = taxonomy.aliases[String(tag).toLowerCase()] || taxonomy.aliases[normalized];
    if (mapped) mappedTopics.push(mapped);
    else issues.push('needs-topic-mapping');
  }
  if (!data.topics) data.topics = unique(mappedTopics);
  if (!data.audiences) data.audiences = [];
  if (!data.images || typeof data.images !== 'object') data.images = {};
  if (!data.images.cover) {
    const bundleDir = path.dirname(path.join(ROOT, rel));
    const localCover = fs.existsSync(bundleDir) ? fs.readdirSync(bundleDir).find(name => /^cover\.(png|jpe?g|webp|avif)$/i.test(name)) : null;
    if (localCover) data.images.cover = localCover;
  }
  nestedSetIfMissing(data, 'research', 'topicSource', data.topic_source);
  nestedSetIfMissing(data, 'research', 'score', data.score);
  nestedSetIfMissing(data, 'research', 'rejectionReason', data.rejection_reason);
  nestedSetIfMissing(data, 'writer', 'hermesSessionId', data.hermes_session_id);
  nestedSetIfMissing(data, 'writer', 'notes', data.writer_notes);
  nestedSetIfMissing(data, 'writer', 'draftVersion', data.draft_version);
  nestedSetIfMissing(data, 'editorial', 'showCitations', data.show_citations);
  if (data.sources) data.sources = convertSources(data.sources);
  else data.sources = [];
  if ((type === 'guide' || type === 'visa') && data.sources.length === 0) issues.push('needs-source-review');
  if (data.sources.some(s => !s.url || !s.title || !s.publisher || s.sourceType === 'unclassified')) issues.push('needs-source-review');
  if (!Array.isArray(data.relations)) data.relations = [];
  if (!Array.isArray(data.affiliateLinks)) data.affiliateLinks = [];
  if (!data.ads || typeof data.ads !== 'object') data.ads = { overrides: {} };
  if (!data.ads.overrides) data.ads.overrides = {};
  for (const zone of Object.keys(data.ads.overrides)) if (!/\d+x\d+/.test(zone)) issues.push('ambiguous-ad-zone');
  nestedSetIfMissing(data, 'publishing', 'scheduledAt', data.scheduled_date);

  const recognized = new Set(['id','type','title','slug','description','status','stage','createdAt','updatedAt','author','category','section','visaCategory','visaCode','visaClass','purpose','entryTypes','minimumAge','initialStayDays','extendable','eligibility','requirements','documents','financialRequirements','publishedAt','topics','audiences','research','writer','editorial','sources','relations','seo','images','social','affiliateLinks','ads','publishing','history','lastVerifiedAt','nextReviewAt','revisionHistory']);
  const mappedLegacy = new Set(['excerpt','published','date','created','updated','categories','tags','topic_source','score','rejection_reason','hermes_session_id','writer_notes','draft_version','show_citations','scheduled_date','published_date','pipeline','sharing','cover']);
  for (const key of Object.keys(before)) if (!recognized.has(key) && !mappedLegacy.has(key)) unknown.push(key);
  return { data, issues: unique(issues), unknown, changed: JSON.stringify(data) !== JSON.stringify(before) };
}

function validateRecords(records, taxonomy) {
  const ids = new Map();
  for (const record of records) {
    if (!PUBLISHABLE.has(record.proposedType)) continue;
    const data = record.transformed;
    if (!data.id || !data.type) record.validationErrors.push('publishable file lacks id or type');
    if (data.type !== record.proposedType) record.validationErrors.push(`type mismatch: ${data.type}`);
    if (data.id) ids.set(data.id, [...(ids.get(data.id) || []), record.path]);
    if (!data.title || !data.slug || !data.description) record.validationErrors.push('required title, slug, or description missing');
    if (data.type === 'post' && !data.publishedAt) record.validationErrors.push('post lacks publishedAt');
    if ((data.type === 'guide' || data.type === 'visa') && data.status === 'current' && (!data.lastVerifiedAt || !data.nextReviewAt)) record.validationErrors.push('current maintained content lacks verification dates');
    for (const topic of asArray(data.topics)) if (!taxonomy.topics.includes(topic)) record.validationErrors.push(`unknown topic: ${topic}`);
  }
  for (const [id, paths] of ids) if (paths.length > 1) for (const rel of paths) {
    records.find(r => r.path === rel).validationErrors.push(`duplicate id ${id}: ${paths.join(', ')}`);
  }
  const validIds = new Set(ids.keys());
  for (const record of records) for (const relation of asArray(record.transformed?.relations)) {
    if (!relation.targetId || relation.targetId === record.transformed.id || !validIds.has(relation.targetId)) {
      record.validationErrors.push(`broken relation: ${relation.targetId || '(missing target)'}`);
      record.categories.push('broken-relation');
    }
  }
}

function serialize(data, body, eol) {
  const frontmatter = yaml.dump(data, { noRefs: true, lineWidth: 1000, quotingType: "'", forceQuotes: false, sortKeys: false });
  const normalizedFrontmatter = frontmatter.replace(/\n/g, eol);
  return `---${eol}${normalizedFrontmatter}---${eol}${body}`;
}

function scan(contentDir, manifest, taxonomy, overrides) {
  const records = [];
  for (const file of filesUnder(contentDir)) {
    const rel = relative(file);
    const raw = fs.readFileSync(file, 'utf8');
    const record = { path: rel, currentUrl: null, proposedUrl: null, proposedType: 'unresolved', confidence: 'low', issues: [], categories: [], hasBody: false, assets: [], unknownFields: [], validationErrors: [], bodySha256: null, transformed: {} };
    try {
      const parsed = parseMatter(raw);
      const source = splitSource(raw);
      const classification = classify(rel, parsed.data, overrides);
      const result = transform(rel, parsed, classification, manifest, taxonomy);
      record.proposedType = classification.type;
      record.confidence = classification.confidence;
      record.classificationReason = classification.reason;
      record.currentUrl = currentUrl(rel, parsed.data, classification.type);
      record.proposedUrl = record.currentUrl;
      record.hasBody = source.body.trim().length > 0;
      record.assets = assetsFor(file, parsed.data, source.body);
      record.bodySha256 = bodyHash(source.body);
      record.transformed = result.data;
      record.unknownFields = result.unknown;
      record.issues = result.issues;
      record.categories.push(...result.issues);
      if (!PUBLISHABLE.has(classification.type)) record.categories.push(classification.type === 'unresolved' ? 'needs-classification' : 'unchanged');
      else record.categories.push(result.changed ? 'migrated' : 'unchanged');
      record.output = serialize(result.data, source.body, source.eol);
      if (!record.output.endsWith(source.body)) record.validationErrors.push('Markdown body changed');
    } catch (error) {
      record.categories.push('invalid-frontmatter');
      record.validationErrors.push(error.message);
    }
    record.categories = unique(record.categories);
    records.push(record);
  }
  validateRecords(records, taxonomy);
  return records;
}

function reportObject(command, contentDir, records, manifest) {
  const summary = Object.fromEntries(REPORT_CATEGORIES.map(category => [category, 0]));
  for (const record of records) for (const category of record.categories) summary[category] = (summary[category] || 0) + 1;
  return {
    generatedAt: new Date().toISOString(), command, contentDirectory: relative(contentDir),
    summary, files: records.map(({ output, transformed, ...record }) => record), idManifest: manifest
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function currentBranch() {
  const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
  return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
}

function printHelp() {
  console.log('Usage: frontmatter-migrate [inventory|dry-run|apply|validate] [--content-dir content-repo] [--report-dir migration/reports] [--branch name]');
  console.log('No command defaults to dry-run. apply requires --branch matching the checked-out non-production branch.');
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const contentDir = resolveInsideRoot(options.contentDir, 'content directory');
  const reportDir = resolveInsideRoot(options.reportDir, 'report directory');
  if (!fs.statSync(contentDir).isDirectory()) throw new Error('content directory does not exist');
  const manifestFile = path.join(CONFIG, 'id-manifest.json');
  const manifest = readJson(manifestFile, {});
  const taxonomy = readJson(path.join(CONFIG, 'taxonomy.json'), { topics: [], aliases: {}, categories: [], sections: [], visaCategories: [] });
  const overrides = readJson(path.join(CONFIG, 'classification-overrides.json'), {});
  const records = scan(contentDir, manifest, taxonomy, overrides);
  const errors = records.reduce((sum, record) => sum + record.validationErrors.length, 0);

  if (command === 'apply') {
    if (!options.branch) throw new Error('apply requires --branch <development-branch>');
    const branch = currentBranch();
    if (!branch || branch !== options.branch) throw new Error(`apply branch mismatch: expected ${options.branch}, checked out ${branch || 'detached HEAD'}`);
    if (/^(main|master|production|prod)$/i.test(branch)) throw new Error('refusing to apply on a production branch');
    const duplicateErrors = records.flatMap(r => r.validationErrors).filter(e => e.startsWith('duplicate id'));
    if (duplicateErrors.length) throw new Error('refusing to apply with unresolved duplicate IDs');
    for (const record of records) if (record.output && PUBLISHABLE.has(record.proposedType)) fs.writeFileSync(path.join(ROOT, record.path), record.output, 'utf8');
    writeJson(manifestFile, manifest);
  }

  const report = reportObject(command, contentDir, records, manifest);
  const reportName = command === 'inventory' ? 'inventory.json' : command === 'dry-run' ? 'dry-run.json' : command === 'validate' ? 'validation.json' : 'apply.json';
  writeJson(path.join(reportDir, reportName), report);
  if (command === 'inventory' || command === 'dry-run') writeJson(path.join(reportDir, 'id-manifest.proposed.json'), manifest);
  console.log(`${command}: ${records.length} files; ${report.summary.migrated} migratable; ${report.summary['needs-classification']} need classification; ${errors} validation errors`);
  console.log(`report: ${slash(path.relative(ROOT, path.join(reportDir, reportName)))}`);
  if (command === 'validate' && errors) process.exitCode = 1;
}

try { main(); }
catch (error) { console.error(`frontmatter-migrate: ${error.message}`); process.exitCode = 1; }
