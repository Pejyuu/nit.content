#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('../workbench/node_modules/gray-matter');
const yaml = require('../workbench/node_modules/js-yaml');

const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const COLLECTIONS = new Map([
  ['posts', 'post'],
  ['guides', 'guide'],
  ['visas', 'visa'],
  ['pages', 'page']
]);
const VALID_PIPELINE_TYPES = new Set(['research', 'idea', 'post', 'guide', 'visa', 'page']);

function filesUnder(directory) {
  const files = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.mdx?$/i.test(entry.name)) files.push(full);
    }
  }
  walk(directory);
  return files.sort();
}

function splitSource(raw) {
  const delimiter = /^---[ \t]*(?:\r?\n|$)/gm;
  const first = delimiter.exec(raw);
  const second = delimiter.exec(raw);
  if (!first || first.index !== 0 || !second) throw new Error('missing YAML frontmatter');
  const eol = first[0].endsWith('\r\n') ? '\r\n' : '\n';
  return { body: raw.slice(second.index + second[0].length), eol };
}

function parse(raw) {
  return matter(raw, {
    engines: { yaml: source => yaml.load(source, { schema: yaml.JSON_SCHEMA }) }
  });
}

function nonEmpty(value) {
  return value !== undefined && value !== null && value !== '';
}

function first(...values) {
  return values.find(nonEmpty);
}

function slugKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function inferredSlug(file, data) {
  const parent = path.basename(path.dirname(file));
  const stem = path.basename(file, path.extname(file));
  return first(data.slug, stem === 'index' ? parent : stem);
}

function inferredYear(file, data) {
  const rel = file.split(path.sep).join('/');
  const match = rel.match(/\/posts\/(20\d{2})\//);
  return match ? match[1] : String(first(data.publishedAt, data.date, '')).slice(0, 4);
}

function canonicalId(type, file, data, slug) {
  if (type === 'post') return `post.${inferredYear(file, data)}.${slugKey(slug)}`;
  return `${type}.${slugKey(slug)}`;
}

function description(data) {
  return first(data.description, data.excerpt, data.seo && data.seo.description);
}

function imageContract(data) {
  const images = data.images && typeof data.images === 'object' && !Array.isArray(data.images)
    ? JSON.parse(JSON.stringify(data.images)) : {};
  if (!images.cover && data.cover) images.cover = data.cover;
  if (!images.social && data.sharing && data.sharing.og_image) {
    images.social = { universal: data.sharing.og_image };
  }
  return images;
}

function common(type, file, data) {
  const slug = inferredSlug(file, data);
  return {
    id: canonicalId(type, file, data, slug),
    type,
    slug,
    published: data.published === true,
    status: first(data.status, data.published === true ? 'published' : 'draft'),
    title: data.title,
    description: description(data),
    excerpt: first(data.excerpt, data.description, data.seo && data.seo.description),
    author: first(data.author, 'marianneh')
  };
}

function sharedEditorial(data) {
  return {
    topics: Array.isArray(data.topics) ? data.topics : [],
    audiences: Array.isArray(data.audiences) ? data.audiences : [],
    images: imageContract(data),
    sources: Array.isArray(data.sources) ? data.sources : [],
    relations: Array.isArray(data.relations) ? data.relations : [],
    affiliateLinks: Array.isArray(data.affiliateLinks) ? data.affiliateLinks : [],
    ads: data.ads && typeof data.ads === 'object' ? data.ads : { overrides: {} }
  };
}

function retainedOptional(data, keys) {
  const out = {};
  for (const key of keys) if (nonEmpty(data[key])) out[key] = data[key];
  return out;
}

function normalizePublished(type, file, data) {
  const base = common(type, file, data);
  let specific;
  if (type === 'post') {
    specific = {
      publishedAt: first(data.publishedAt, data.date),
      updatedAt: first(data.updatedAt, data.updated),
      category: first(data.category, Array.isArray(data.categories) ? data.categories[0] : data.categories),
      ...retainedOptional(data, ['writer', 'marketing', 'publishing', 'seo'])
    };
  } else if (type === 'page') {
    specific = {
      updatedAt: first(data.updatedAt, data.lastUpdated, data.updated),
      ...retainedOptional(data, ['lastVerifiedAt', 'nextReviewAt', 'revisionHistory', 'seo'])
    };
  } else {
    specific = {
      updatedAt: first(data.updatedAt, data.updated),
      lastVerifiedAt: first(data.lastVerifiedAt, data.pipeline && data.pipeline.last_verified),
      nextReviewAt: data.nextReviewAt,
      revisionHistory: Array.isArray(data.revisionHistory) ? data.revisionHistory : [],
      ...retainedOptional(data, type === 'visa'
        ? ['visaCategory', 'visaCode', 'visaClass', 'purpose', 'entryTypes', 'minimumAge',
          'initialStayDays', 'extendable', 'eligibility', 'requirements', 'documents',
          'financialRequirements', 'seo']
        : ['section', 'seo'])
    };
  }
  const normalized = { ...base, ...specific, ...sharedEditorial(data) };
  if (data.pipeline && typeof data.pipeline === 'object' && !Array.isArray(data.pipeline)) {
    normalized.pipeline = data.pipeline;
  }
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

function serialize(data, body, eol) {
  const header = yaml.dump(data, {
    noRefs: true, lineWidth: 1000, quotingType: "'", forceQuotes: false, sortKeys: false
  }).replace(/\n/g, eol);
  return `---${eol}${header}---${eol}${body}`;
}

function validate(type, file, data) {
  const errors = [];
  for (const key of ['id', 'type', 'slug', 'status', 'title', 'description', 'author']) {
    if (!nonEmpty(data[key])) errors.push(`${key} is required`);
  }
  if (data.type !== type) errors.push(`expected type ${type}`);
  if (data.type === 'post' && !data.publishedAt) errors.push('publishedAt is required');
  return errors.map(error => `${path.relative(ROOT, file)}: ${error}`);
}

function main() {
  const check = process.argv.includes('--check');
  const bodies = new Map();
  const ids = new Map();
  const errors = [];
  let changed = 0;
  let total = 0;

  for (const [directory, type] of COLLECTIONS) {
    for (const file of filesUnder(path.join(CONTENT, directory))) {
      total += 1;
      const raw = fs.readFileSync(file, 'utf8');
      const source = splitSource(raw);
      const data = parse(raw).data;
      bodies.set(file, source.body);
      const normalized = normalizePublished(type, file, data);
      errors.push(...validate(type, file, normalized));
      ids.set(normalized.id, [...(ids.get(normalized.id) || []), path.relative(ROOT, file)]);
      const output = serialize(normalized, source.body, source.eol);
      if (output !== raw) {
        changed += 1;
        if (!check) fs.writeFileSync(file, output, 'utf8');
      }
    }
  }

  for (const [id, paths] of ids) {
    if (paths.length > 1) errors.push(`duplicate id ${id}: ${paths.join(', ')}`);
  }

  for (const file of filesUnder(path.join(ROOT, 'pipeline'))) {
    const data = parse(fs.readFileSync(file, 'utf8')).data;
    if (!nonEmpty(data.type)) errors.push(`${path.relative(ROOT, file)}: type is required`);
    else if (!VALID_PIPELINE_TYPES.has(data.type)) {
      errors.push(`${path.relative(ROOT, file)}: invalid pipeline type ${data.type}`);
    }
    if (!data.pipeline || typeof data.pipeline !== 'object') {
      errors.push(`${path.relative(ROOT, file)}: pipeline block is required`);
    }
  }

  if (!check) {
    for (const [file, body] of bodies) {
      if (splitSource(fs.readFileSync(file, 'utf8')).body !== body) {
        errors.push(`${path.relative(ROOT, file)}: Markdown body changed`);
      }
    }
  }

  console.log(`${check ? 'Checked' : 'Normalized'} ${total} published files; ${changed} ${check ? 'would change' : 'changed'}.`);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  }
}

main();
