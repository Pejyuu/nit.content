const express = require('express');
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Four roots: pipeline (research/ideas/drafts, organize however) plus one
// per published type. Root keys for the published three double as the
// card's own "type" value — "mark as published" just looks up ROOTS[type].
const ROOTS = { pipeline: path.resolve(__dirname, config.pipelineDir) };
Object.keys(config.publishedDirs).forEach(function (type) {
  ROOTS[type] = path.resolve(__dirname, config.publishedDirs[type]);
});

Object.values(ROOTS).forEach(function (dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function walkMdxFiles(dir, base) {
  base = base || dir;
  var out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkMdxFiles(full, base));
    } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  });
  return out;
}

function idToPath(id) {
  // id format: "rootKey/relative/path.mdx" — relative path may itself
  // contain slashes, since subfolders under a root are just organization.
  var slash = id.indexOf('/');
  if (slash === -1) throw new Error('Invalid id: ' + id);
  var rootKey = id.slice(0, slash);
  var relPath = id.slice(slash + 1);
  if (!ROOTS[rootKey]) throw new Error('Unknown root: ' + rootKey);
  if (relPath.indexOf('..') !== -1 || path.isAbsolute(relPath)) throw new Error('Invalid path');
  return path.join(ROOTS[rootKey], relPath);
}

// Published collections (post/guide/docs) validate frontmatter against the
// site's Astro schema, where unset optional fields must be absent — not
// `null`. Pipeline cards keep their nulls (that's the standard shape while
// still in progress); this strips them right before a card crosses into a
// published root, so the file that lands there conforms to the real schema.
function isPublishedRoot(rootKey) {
  return rootKey !== 'pipeline';
}

function pruneNullsDeep(value) {
  if (Array.isArray(value)) return value.map(pruneNullsDeep);
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function (key) {
      var v = value[key];
      if (v === null) return;
      out[key] = pruneNullsDeep(v);
    });
    return out;
  }
  return value;
}

function slugifyName(str) {
  return (str || 'untitled')
    .toString()
    .toLowerCase()
    .replace(/\.mdx$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'untitled';
}

function uniqueFilename(dir, base) {
  var finalName = base + '.mdx';
  var full = path.join(dir, finalName);
  var n = 2;
  while (fs.existsSync(full)) {
    finalName = base + '-' + n + '.mdx';
    full = path.join(dir, finalName);
    n += 1;
  }
  return finalName;
}

// The standard shape every file Workbench creates uses: site fields at the
// top level (identical shape to a real published post, blank until known)
// plus our own tracking fields always nested under `pipeline:`.
function standardFrontmatter(type, title) {
  return {
    type: type,
    title: title,
    published: false,
    date: null,
    author: 'marianneh',
    slug: null,
    categories: null,
    cover: null,
    allow_comment: false,
    thread_id: null,
    excerpt: null,
    adIds: null,
    sharing: {
      og_image: null,
      twitter_card: 'summary_large_image'
    },
    pipeline: {
      stage: (config.stages && config.stages[0]) || 'candidate',
      writing_effort: null,
      verification_burden: null,
      hold_until: null,
      publish_date: null,
      reject_reason: null,
      content_category: null,
      resurface_cooldown: null,
      last_verified: null,
      last_touched: new Date().toISOString(),
      source_research: null,
      source_idea: null,
      source_url: null
    }
  };
}

function readAllCards() {
  var cards = [];
  Object.keys(ROOTS).forEach(function (rootKey) {
    var dir = ROOTS[rootKey];
    walkMdxFiles(dir).forEach(function (relPath) {
      var full = path.join(dir, relPath);
      var raw = fs.readFileSync(full, 'utf8');
      var parsed = matter(raw);
      // Visibility rule: a file with no pipeline: block is invisible to
      // Workbench — this is what lets the app scan straight over
      // content/posts|guides|docs without surfacing the legacy back-catalog.
      if (!parsed.data.pipeline || typeof parsed.data.pipeline !== 'object') return;
      cards.push({
        id: rootKey + '/' + relPath,
        root: rootKey,
        type: parsed.data.type || rootKey,
        frontmatter: parsed.data,
        body: parsed.content
      });
    });
  });
  return cards;
}

app.get('/api/config', function (req, res) {
  res.json({
    stages: config.stages,
    types: config.types || [],
    siteCategories: config.siteCategories || []
  });
});

app.get('/api/cards', function (req, res) {
  try {
    res.json(readAllCards());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full replace of a card's frontmatter + body, in place (no move).
app.patch('/api/cards', function (req, res) {
  var id = req.body.id;
  var frontmatter = req.body.frontmatter;
  var body = req.body.body;
  try {
    var filePath = idToPath(id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    var rootKey = id.slice(0, id.indexOf('/'));
    var toWrite = isPublishedRoot(rootKey) ? pruneNullsDeep(frontmatter || {}) : (frontmatter || {});
    fs.writeFileSync(filePath, matter.stringify(body || '', toWrite));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// New cards always land in the pipeline root, regardless of type — nothing
// starts published. Frontmatter always gets the full standard shape.
app.post('/api/cards', function (req, res) {
  var subdir = req.body.subdir || '';
  var type = req.body.type || (config.types && config.types[0]) || 'research';
  var title = req.body.title || 'Untitled';
  var body = req.body.body || '';
  try {
    if (subdir.indexOf('..') !== -1) throw new Error('Invalid subdir');
    var dir = path.join(ROOTS.pipeline, subdir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var frontmatter = standardFrontmatter(type, title);
    var base = slugifyName(title);
    var finalName = uniqueFilename(dir, base);
    fs.writeFileSync(path.join(dir, finalName), matter.stringify(body, frontmatter));
    var relPath = subdir ? (subdir.replace(/\/$/, '') + '/' + finalName) : finalName;
    res.json({ id: 'pipeline/' + relPath });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Move a card between roots (used to physically pull a file out of the
// pipeline into one of the three published folders — "move on publish").
// Also handles the frontmatter/body update in the same step so it's one
// atomic write.
app.post('/api/cards/move', function (req, res) {
  var id = req.body.id;
  var toRoot = req.body.toRoot;
  var filename = req.body.filename;
  var frontmatter = req.body.frontmatter || {};
  var body = req.body.body || '';
  try {
    if (!ROOTS[toRoot]) throw new Error('Unknown root: ' + toRoot);
    var oldPath = idToPath(id);
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Not found' });
    // Scheduling onto the calendar already relocates post/guide/docs cards
    // into their target root (see /api/cards/reschedule below) — if this
    // card is already there, just update the frontmatter in place instead
    // of re-slugifying and moving it a second time.
    var movedFrontmatter = isPublishedRoot(toRoot) ? pruneNullsDeep(frontmatter) : frontmatter;
    if (id.slice(0, id.indexOf('/')) === toRoot) {
      fs.writeFileSync(oldPath, matter.stringify(body, movedFrontmatter));
      return res.json({ id: id });
    }
    var targetDir = ROOTS[toRoot];
    var base = slugifyName(filename || frontmatter.slug || frontmatter.title);
    var finalName = uniqueFilename(targetDir, base);
    fs.writeFileSync(path.join(targetDir, finalName), matter.stringify(body, movedFrontmatter));
    fs.unlinkSync(oldPath);
    res.json({ id: toRoot + '/' + finalName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function stripDatePrefix(base) {
  var m = base.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
  return m ? m[1] : base;
}

// Where a card's file should live for a given root + publish date. Posts are
// organized into content/posts/YYYY/MM/ (matching the site's existing
// convention); guides/docs/pipeline stay flat. Creates the folder if needed.
function targetDirForRoot(rootKey, dateStr) {
  var base = ROOTS[rootKey];
  if (rootKey !== 'post') return base;
  var parts = dateStr.split('-');
  var dir = path.join(base, parts[0], parts[1]);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Renames a card's file so its filename's date prefix matches a newly
// assigned publish_date, keeping the existing slug — and, if the card's
// type is post/guide/docs (sent as toRoot), physically moves it out of the
// pipeline into that published root at the same time (year/month subfolder
// for posts). Used only when a card is scheduled onto the calendar
// (drag-and-drop from the Ready list).
app.post('/api/cards/reschedule', function (req, res) {
  var id = req.body.id;
  var dateStr = req.body.date;
  var toRoot = req.body.toRoot;
  var frontmatter = req.body.frontmatter || {};
  var body = req.body.body || '';
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) throw new Error('Invalid date');
    var oldPath = idToPath(id);
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Not found' });
    var rootKey = id.slice(0, id.indexOf('/'));
    if (toRoot && !ROOTS[toRoot]) throw new Error('Unknown root: ' + toRoot);
    var finalRoot = toRoot || rootKey;
    var dir = targetDirForRoot(finalRoot, dateStr);
    var oldBase = path.basename(oldPath, '.mdx');
    var desiredBase = dateStr + '-' + stripDatePrefix(oldBase);
    var desiredPath = path.join(dir, desiredBase + '.mdx');
    var rescheduledFrontmatter = isPublishedRoot(finalRoot) ? pruneNullsDeep(frontmatter) : frontmatter;

    if (desiredPath === oldPath) {
      fs.writeFileSync(oldPath, matter.stringify(body, rescheduledFrontmatter));
      return res.json({ id: id });
    }

    var finalName = uniqueFilename(dir, desiredBase);
    fs.writeFileSync(path.join(dir, finalName), matter.stringify(body, rescheduledFrontmatter));
    fs.unlinkSync(oldPath);
    var relPath = path.relative(ROOTS[finalRoot], path.join(dir, finalName)).split(path.sep).join('/');
    res.json({ id: finalRoot + '/' + relPath });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Wildcard so nested relative paths (subfolders) delete correctly.
app.delete('/api/cards/*', function (req, res) {
  try {
    var filePath = idToPath(req.params[0]);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

var PORT = process.env.PORT || config.port || 4173;
app.listen(PORT, function () {
  console.log('Workbench running at http://localhost:' + PORT);
  Object.keys(ROOTS).forEach(function (key) {
    console.log('  ' + key + ': ' + ROOTS[key]);
  });
});
