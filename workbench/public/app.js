var STAGES = [];
var TYPES = [];
var SITE_CATEGORIES = [];
var cards = [];
var currentCard = null;
var calMonth = new Date(); calMonth.setDate(1); calMonth.setHours(0, 0, 0, 0);

// Root keys for the three published destinations. A card whose root is one
// of these has already been physically moved out of the pipeline.
var PUBLISHED_ROOTS = ['post', 'guide', 'docs'];

// ---------- frontmatter field helpers ----------
// Every visible card is guaranteed to have a pipeline: block (the server's
// visibility rule filters out anything without one), so pipeline fields are
// always nested — no more auto-detecting top-level vs. nested shape.
function getStage(card) { return card.frontmatter.pipeline.stage || STAGES[0]; }
function getTitle(card) { return card.frontmatter.title || '(untitled)'; }
function getEffort(card) { return Number(card.frontmatter.pipeline.writing_effort) || 0; }
function getVerification(card) { return Number(card.frontmatter.pipeline.verification_burden) || 0; }
function getHoldUntil(card) { return card.frontmatter.pipeline.hold_until || ''; }
function getPublishDate(card) { return card.frontmatter.pipeline.publish_date || ''; }
// publish_date may carry a 'T'-separated time (e.g. "2026-07-12T14:30") —
// pull just the HH:mm back out for the time input.
function getPublishTime(card) {
  var pub = getPublishDate(card);
  var idx = String(pub).indexOf('T');
  return idx === -1 ? '' : String(pub).slice(idx + 1, idx + 6);
}

function roundToStepMinutes(timeStr, step) {
  var parts = timeStr.split(':');
  var total = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  var rounded = Math.round(total / step) * step % (24 * 60);
  return String(Math.floor(rounded / 60)).padStart(2, '0') + ':' + String(rounded % 60).padStart(2, '0');
}

// A themed <select> instead of the browser's native time-picker widget (which
// ignores the app's dark theme). Options run every 30 minutes; an existing
// off-grid time (older posts have arbitrary minute values) is added in so
// reopening a card never silently shifts its time.
function timeOptionsHtml(current) {
  var options = [];
  for (var h = 0; h < 24; h++) {
    for (var m = 0; m < 60; m += 30) {
      options.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
    }
  }
  if (current && options.indexOf(current) === -1) options.push(current);
  options.sort();
  return options.map(function (t) {
    return '<option value="' + t + '"' + (t === current ? ' selected' : '') + '>' + t + '</option>';
  }).join('');
}
function getLastTouched(card) { return card.frontmatter.pipeline.last_touched || '1970-01-01'; }
// Not every published card has publish_date (older guides/docs never had a
// `date` field to carry one over) — fall back to last_verified, then the
// site date field, so the Published tab can still sort them sensibly.
function getEffectivePublishDate(card) {
  return getPublishDate(card) || card.frontmatter.pipeline.last_verified || card.frontmatter.date || '';
}
function isHeld(card) {
  var h = getHoldUntil(card);
  if (!h) return false;
  var d = new Date(h);
  if (isNaN(d)) return false;
  var today = new Date(); today.setHours(0, 0, 0, 0);
  return d > today;
}
function isScheduled(card) { return !!getPublishDate(card); }
function findCard(id) { return cards.filter(function (c) { return c.id === id; })[0]; }

function slugifyTitle(str) {
  return (str || 'untitled').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'untitled';
}

// Fields the site's Astro schema requires as a real string/number, not the
// `null` Workbench seeds them with — keyed by published type, since guides
// and docs don't carry author/cover/thread_id at all (see .pages.yml).
var PUBLISH_FIELD_DEFS = {
  post: [
    { key: 'author', label: 'Author', get: function (fm) { return fm.author; }, set: function (fm, v) { fm.author = v; }, guess: function (card) { return card.frontmatter.author || 'marianneh'; } },
    { key: 'slug', label: 'Slug', get: function (fm) { return fm.slug; }, set: function (fm, v) { fm.slug = v; }, guess: function (card) { return slugifyTitle(card.frontmatter.title); } },
    { key: 'categories', label: 'Category', kind: 'select', options: function () { return SITE_CATEGORIES; }, get: function (fm) { return fm.categories; }, set: function (fm, v) { fm.categories = v; }, guess: function (card) { return card.frontmatter.categories || SITE_CATEGORIES[0] || ''; } },
    { key: 'cover', label: 'Cover image path', get: function (fm) { return fm.cover; }, set: function (fm, v) { fm.cover = v; }, guess: function (card) { return card.frontmatter.cover || '/src/cms/content/media/cover_placeholder.png'; } },
    { key: 'thread_id', label: 'Comment thread ID', get: function (fm) { return fm.thread_id; }, set: function (fm, v) { fm.thread_id = Number(v) || 0; }, guess: function () { return '0'; } },
    { key: 'og_image', label: 'Open Graph image path', get: function (fm) { return fm.sharing && fm.sharing.og_image; }, set: function (fm, v) { fm.sharing = fm.sharing || {}; fm.sharing.og_image = v; }, guess: function (card) { return card.frontmatter.cover || '/src/cms/content/media/some_placeholder.png'; } }
  ],
  guide: [
    { key: 'slug', label: 'Slug', get: function (fm) { return fm.slug; }, set: function (fm, v) { fm.slug = v; }, guess: function (card) { return slugifyTitle(card.frontmatter.title); } },
    { key: 'og_image', label: 'Open Graph image path', get: function (fm) { return fm.sharing && fm.sharing.og_image; }, set: function (fm, v) { fm.sharing = fm.sharing || {}; fm.sharing.og_image = v; }, guess: function (card) { return card.frontmatter.cover || '/src/cms/content/media/some_placeholder.png'; } }
  ]
};
PUBLISH_FIELD_DEFS.docs = PUBLISH_FIELD_DEFS.guide;

function isEmptyPublishValue(v) { return v === null || v === undefined || v === ''; }
function getEmptyPublishFields(card) {
  var defs = PUBLISH_FIELD_DEFS[card.type] || [];
  return defs.filter(function (d) { return isEmptyPublishValue(d.get(card.frontmatter)); });
}

// Gate for any action that moves a card into a published root (post/guide/
// docs): if the site-required fields are still empty/null, show a pop-up
// pre-filled with sensible guesses so the author confirms or corrects them
// before the file ever gets written where the real schema validates it.
function ensurePublishFieldsFilled(card, onReady) {
  if (PUBLISHED_ROOTS.indexOf(card.type) === -1) { onReady(); return; }
  var missing = getEmptyPublishFields(card);
  if (!missing.length) { onReady(); return; }
  openFillFieldsModal(card, missing, onReady);
}

function missingFieldsHtml(card, missingDefs) {
  return missingDefs.map(function (d) {
    var current = d.guess(card);
    if (d.kind === 'select') {
      var opts = d.options().map(function (o) {
        return '<option value="' + escapeHtml(o) + '"' + (o === current ? ' selected' : '') + '>' + escapeHtml(o) + '</option>';
      }).join('');
      return '<div class="field"><label>' + escapeHtml(d.label) + '</label>' +
        '<select id="fill-' + d.key + '" required>' + opts + '</select></div>';
    }
    return '<div class="field"><label>' + escapeHtml(d.label) + '</label>' +
      '<input type="text" id="fill-' + d.key + '" value="' + escapeHtml(current) + '" required></div>';
  }).join('');
}

function applyMissingFields(card, missingDefs) {
  missingDefs.forEach(function (d) {
    d.set(card.frontmatter, document.getElementById('fill-' + d.key).value);
  });
}

function openFillFieldsModal(card, missingDefs, onConfirm) {
  document.getElementById('cardModal').innerHTML =
    '<h2>Before publishing &ldquo;' + escapeHtml(getTitle(card)) + '&rdquo;</h2>' +
    '<p class="field-empty">These fields are required by the site and currently empty. Sensible defaults are pre-filled &mdash; check them, then confirm.</p>' +
    '<form id="fillForm">' + missingFieldsHtml(card, missingDefs) +
    '<div class="modal-actions"><div class="left"></div><div>' +
    '<button type="button" class="btn" id="fill-cancel">Cancel</button> ' +
    '<button type="submit" class="btn accent-content" id="fill-confirm">Confirm &amp; continue</button>' +
    '</div></div></form>';
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('fill-cancel').addEventListener('click', closeModal);
  document.getElementById('fillForm').addEventListener('submit', function (e) {
    e.preventDefault();
    applyMissingFields(card, missingDefs);
    closeModal();
    onConfirm();
  });
}

// Dragging a card onto a calendar day has no time picker of its own, so this
// pop-up always asks for a publish time there (defaulting to the card's
// existing time, or now), and — for post/guide/docs — folds in the same
// required-field check used before a "Mark as published" move.
function openScheduleModal(card, dateStr, onConfirm) {
  var missing = PUBLISHED_ROOTS.indexOf(card.type) !== -1 ? getEmptyPublishFields(card) : [];
  var defaultTime = getPublishTime(card) || roundToStepMinutes(new Date().toTimeString().slice(0, 5), 30);
  document.getElementById('cardModal').innerHTML =
    '<h2>Schedule &ldquo;' + escapeHtml(getTitle(card)) + '&rdquo; for ' + escapeHtml(dateStr) + '</h2>' +
    (missing.length ? '<p class="field-empty">These fields are required by the site and currently empty. Sensible defaults are pre-filled &mdash; check them, then confirm.</p>' : '') +
    '<form id="scheduleForm">' +
    '<div class="field"><label>Publish time</label><select id="sched-time" required>' + timeOptionsHtml(defaultTime) + '</select></div>' +
    missingFieldsHtml(card, missing) +
    '<div class="modal-actions"><div class="left"></div><div>' +
    '<button type="button" class="btn" id="sched-cancel">Cancel</button> ' +
    '<button type="submit" class="btn accent-content" id="sched-confirm">Confirm &amp; schedule</button>' +
    '</div></div></form>';
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('sched-cancel').addEventListener('click', closeModal);
  document.getElementById('scheduleForm').addEventListener('submit', function (e) {
    e.preventDefault();
    applyMissingFields(card, missing);
    var time = document.getElementById('sched-time').value;
    closeModal();
    onConfirm(time);
  });
}

function normalizeDate(str) {
  if (!str) return '';
  var parts = String(str).split('-');
  if (parts.length !== 3) return String(str);
  var y = parts[0];
  var m = String(parseInt(parts[1], 10)).padStart(2, '0');
  var d = String(parseInt(parts[2], 10)).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ---------- API ----------
function loadCards() {
  return fetch('/api/cards').then(function (r) { return r.json(); }).then(function (data) {
    cards = data;
    renderAll();
  });
}
function patchCard(card) {
  return fetch('/api/cards', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: card.id, frontmatter: card.frontmatter, body: card.body })
  }).then(function (r) {
    if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'save failed'); });
  }).catch(function (e) { alert('Could not save: ' + e.message); });
}
// Renames the card's file so its date prefix matches a newly assigned
// publish_date, and — if the card is a post/guide/docs — physically moves it
// out of the pipeline into its published root at the same time. Used only
// when scheduling a ready card onto the calendar.
function rescheduleCard(card, dateStr) {
  var toRoot = PUBLISHED_ROOTS.indexOf(card.type) !== -1 ? card.type : undefined;
  return fetch('/api/cards/reschedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: card.id, date: dateStr, toRoot: toRoot, frontmatter: card.frontmatter, body: card.body })
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error(data.error || 'save failed');
      card.id = data.id;
    });
  }).catch(function (e) { alert('Could not save: ' + e.message); });
}

function renderAll() { renderBoard(); renderCalendar(); renderPublished(); renderHeld(); renderArchived(); }

// ---------- board ----------
function cardHtml(card) {
  var effort = getEffort(card), verification = getVerification(card);
  var dots = function (n) {
    var out = '';
    for (var i = 1; i <= 5; i++) out += '<span class="' + (i <= n ? 'filled' : '') + '"></span>';
    return out;
  };
  var showYayNay = getStage(card) === STAGES[0];
  return '<div class="card type-' + card.type + '" draggable="true" data-id="' + card.id + '">' +
    '<h4>' + escapeHtml(getTitle(card)) + '</h4>' +
    '<div class="card-meta"><span class="badge type-' + card.type + '">' + escapeHtml(card.type) + '</span>' +
    ((effort || verification) ? '<span><span class="effort-dots">' + dots(effort) +
      '</span><span class="effort-dots" style="margin-left:4px">' + dots(verification) + '</span></span>' : '') +
    '</div>' +
    (showYayNay ? '<div class="card-actions"><button class="yay" data-id="' + card.id + '">Yay</button>' +
      '<button class="nay" data-id="' + card.id + '">Nay</button></div>' : '') +
    '</div>';
}

function wireCardEvents(root) {
  root = root || document;
  root.querySelectorAll('.card').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      openModal(findCard(el.dataset.id));
    });
    el.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('text/plain', el.dataset.id);
    });
  });
  root.querySelectorAll('.card-actions .yay').forEach(function (btn) {
    btn.addEventListener('click', function (e) { e.stopPropagation(); quickYay(btn.dataset.id); });
  });
  root.querySelectorAll('.card-actions .nay').forEach(function (btn) {
    btn.addEventListener('click', function (e) { e.stopPropagation(); quickNay(btn.dataset.id); });
  });
}

function quickYay(id) {
  var card = findCard(id);
  card.frontmatter.pipeline.stage = STAGES[1] || STAGES[0];
  card.frontmatter.pipeline.last_touched = new Date().toISOString();
  patchCard(card).then(renderAll);
}
function quickNay(id) {
  var card = findCard(id);
  var reason = prompt('Why nay? (optional, helps the hunter avoid resurfacing it too soon)') || '';
  card.frontmatter.pipeline.reject_reason = reason;
  card.frontmatter.pipeline.stage = 'archived';
  patchCard(card).then(renderAll);
}

function wireDropzones() {
  document.querySelectorAll('.column-drop').forEach(function (zone) {
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.closest('.column').classList.add('dragover'); });
    zone.addEventListener('dragleave', function () { zone.closest('.column').classList.remove('dragover'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.closest('.column').classList.remove('dragover');
      var id = e.dataTransfer.getData('text/plain');
      var card = findCard(id);
      if (!card) return;
      card.frontmatter.pipeline.stage = zone.dataset.stage;
      card.frontmatter.pipeline.last_touched = new Date().toISOString();
      patchCard(card).then(renderAll);
    });
  });
}

function renderBoard() {
  var container = document.getElementById('boardColumns');
  container.innerHTML = '';
  // Published cards live on the dedicated Published tab, not the board.
  // Scheduled-but-not-yet-published cards graduate off the board onto the
  // calendar instead.
  var visible = cards.filter(function (c) {
    return !isHeld(c) && !isScheduled(c) && getStage(c) !== 'published';
  });
  // published/archived don't get a board column at all — published lives on
  // its own tab, archived has no established use here.
  var BOARD_STAGES = STAGES.filter(function (s) { return s !== 'published' && s !== 'archived'; });
  BOARD_STAGES.forEach(function (stage) {
    var col = document.createElement('div');
    col.className = 'column';
    col.dataset.stage = stage;
    var inColumn = visible.filter(function (c) { return getStage(c) === stage; });
    inColumn.sort(function (a, b) {
      var ea = getEffort(a) + getVerification(a);
      var eb = getEffort(b) + getVerification(b);
      if (ea !== eb) return ea - eb;
      return new Date(getLastTouched(a)) - new Date(getLastTouched(b));
    });
    col.innerHTML = '<div class="column-head"><h3>' + stage + '</h3><span class="column-count">' + inColumn.length + '</span></div>' +
      '<div class="cards column-drop" data-stage="' + stage + '">' +
      (inColumn.length ? inColumn.map(cardHtml).join('') : '<div class="empty-col">Nothing here</div>') +
      '</div>';
    container.appendChild(col);
  });
  wireCardEvents(container);
  wireDropzones();
  updateTabBadge('heldBadge', cards.filter(isHeld).length);
  updateTabBadge('archivedBadge', cards.filter(function (c) { return getStage(c) === 'archived'; }).length);
}

function updateTabBadge(id, count) {
  var el = document.getElementById(id);
  el.textContent = count;
  el.style.display = count ? 'inline-block' : 'none';
}

// ---------- calendar ----------
function renderCalendar() {
  document.getElementById('calLabel').textContent = calMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
  var grid = document.getElementById('calGrid');
  grid.innerHTML = '';
  var year = calMonth.getFullYear(), month = calMonth.getMonth();
  var startOffset = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  var scheduled = cards.filter(isScheduled);
  var today = new Date();
  var todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

  for (var i = 0; i < startOffset; i++) {
    var pad = document.createElement('div'); pad.className = 'cal-cell empty';
    grid.appendChild(pad);
  }
  var makeDropHandler = function (cell, dateStr) {
    cell.addEventListener('dragover', function (e) { e.preventDefault(); cell.classList.add('dragover'); });
    cell.addEventListener('dragleave', function () { cell.classList.remove('dragover'); });
    cell.addEventListener('drop', function (e) {
      e.preventDefault();
      cell.classList.remove('dragover');
      var id = e.dataTransfer.getData('text/plain');
      var card = findCard(id);
      if (!card) return;
      // Scheduling a post/guide/docs card onto the calendar counts as
      // publishing it outright — it's moved into its published root (see
      // rescheduleCard) and flagged published right away, same as the
      // modal's "Mark as published" action. openScheduleModal always asks
      // for a publish time (the calendar cell only carries a date) and, for
      // post/guide/docs, folds in the same required-field check as
      // ensurePublishFieldsFilled.
      openScheduleModal(card, dateStr, function (time) {
        var stamped = time ? (dateStr + 'T' + time) : dateStr;
        card.frontmatter.pipeline.publish_date = stamped;
        card.frontmatter.pipeline.last_touched = new Date().toISOString();
        if (PUBLISHED_ROOTS.indexOf(card.type) !== -1) {
          card.frontmatter.date = stamped;
          card.frontmatter.published = true;
          card.frontmatter.pipeline.stage = 'published';
        }
        rescheduleCard(card, dateStr).then(renderAll);
      });
    });
  };
  for (var d = 1; d <= daysInMonth; d++) {
    var cell = document.createElement('div'); cell.className = 'cal-cell';
    var dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    if (dateStr === todayStr) cell.classList.add('today');
    var dayCards = scheduled.filter(function (c) { return normalizeDate(getPublishDate(c)) === dateStr; });
    cell.innerHTML = '<div class="day-num">' + d + '</div>' + dayCards.map(function (c) {
      return '<div class="cal-card type-' + c.type + '" data-id="' + c.id + '">' + escapeHtml(getTitle(c)) + '</div>';
    }).join('');
    makeDropHandler(cell, dateStr);
    grid.appendChild(cell);
  }
  grid.querySelectorAll('.cal-card').forEach(function (el) {
    el.addEventListener('click', function () { openModal(findCard(el.dataset.id)); });
  });
  renderReadyList();
}

function renderReadyList() {
  var readyStageName = STAGES[Math.max(STAGES.length - 3, 0)];
  var list = cards.filter(function (c) {
    return !isHeld(c) && !isScheduled(c) && getStage(c) === readyStageName;
  });
  var box = document.getElementById('readyList');
  box.innerHTML = list.length ? list.map(cardHtml).join('') : '<div class="empty-col">Nothing ready yet</div>';
  wireCardEvents(box);
}

// ---------- published ----------
function publishedRowHtml(card) {
  var fm = card.frontmatter;
  var pub = getEffectivePublishDate(card);
  var meta = [];
  meta.push('<span class="badge type-' + card.type + '">' + escapeHtml(card.type) + '</span>');
  if (fm.categories) meta.push('<span class="detail-tag">' + escapeHtml(fm.categories) + '</span>');
  if (fm.pipeline.content_category) meta.push('<span class="detail-tag">' + escapeHtml(fm.pipeline.content_category) + '</span>');
  if (pub) meta.push('<span class="detail-date">' + escapeHtml(normalizeDate(pub)) + '</span>');
  if (fm.pipeline.last_verified) meta.push('<span class="detail-verified">verified ' + escapeHtml(normalizeDate(fm.pipeline.last_verified)) + '</span>');
  return '<div class="detail-row type-' + card.type + '" data-id="' + card.id + '">' +
    '<h4>' + escapeHtml(getTitle(card)) + '</h4>' +
    '<div class="detail-row-meta">' + meta.join('') + '</div>' +
    (fm.excerpt ? '<p class="detail-excerpt">' + escapeHtml(fm.excerpt) + '</p>' : '') +
    '</div>';
}

function renderPublished() {
  var published = cards.filter(function (c) { return getStage(c) === 'published'; });
  published.sort(function (a, b) {
    return new Date(getEffectivePublishDate(b)) - new Date(getEffectivePublishDate(a));
  });
  var box = document.getElementById('publishedList');
  box.innerHTML = published.length ? published.map(publishedRowHtml).join('') : '<div class="empty-col">Nothing published yet</div>';
  box.querySelectorAll('.detail-row').forEach(function (el) {
    el.addEventListener('click', function () { openModal(findCard(el.dataset.id)); });
  });
}

// ---------- held ----------
function heldRowHtml(card) {
  var fm = card.frontmatter;
  var meta = [];
  meta.push('<span class="badge type-' + card.type + '">' + escapeHtml(card.type) + '</span>');
  meta.push('<span class="detail-date">held until ' + escapeHtml(normalizeDate(getHoldUntil(card))) + '</span>');
  return '<div class="detail-row type-' + card.type + '" data-id="' + card.id + '">' +
    '<h4>' + escapeHtml(getTitle(card)) + '</h4>' +
    '<div class="detail-row-meta">' + meta.join('') + '</div>' +
    (fm.excerpt ? '<p class="detail-excerpt">' + escapeHtml(fm.excerpt) + '</p>' : '') +
    '<div class="detail-row-actions"><button type="button" data-id="' + card.id + '">release now</button></div>' +
    '</div>';
}

function renderHeld() {
  var held = cards.filter(isHeld);
  held.sort(function (a, b) { return new Date(getHoldUntil(a)) - new Date(getHoldUntil(b)); });
  var box = document.getElementById('heldList');
  box.innerHTML = held.length ? held.map(heldRowHtml).join('') : '<div class="empty-col">Nothing held right now</div>';
  box.querySelectorAll('.detail-row').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      openModal(findCard(el.dataset.id));
    });
  });
  box.querySelectorAll('.detail-row-actions button').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var card = findCard(btn.dataset.id);
      card.frontmatter.pipeline.hold_until = '';
      patchCard(card).then(renderAll);
    });
  });
}

// ---------- archived ----------
function archivedRowHtml(card) {
  var fm = card.frontmatter;
  var meta = [];
  meta.push('<span class="badge type-' + card.type + '">' + escapeHtml(card.type) + '</span>');
  if (fm.pipeline.reject_reason) meta.push('<span class="detail-tag">' + escapeHtml(fm.pipeline.reject_reason) + '</span>');
  return '<div class="detail-row type-' + card.type + '" data-id="' + card.id + '">' +
    '<h4>' + escapeHtml(getTitle(card)) + '</h4>' +
    '<div class="detail-row-meta">' + meta.join('') + '</div>' +
    (fm.excerpt ? '<p class="detail-excerpt">' + escapeHtml(fm.excerpt) + '</p>' : '') +
    '<div class="detail-row-actions"><button type="button" data-id="' + card.id + '">restore</button></div>' +
    '</div>';
}

function renderArchived() {
  var archived = cards.filter(function (c) { return getStage(c) === 'archived'; });
  archived.sort(function (a, b) { return new Date(getLastTouched(b)) - new Date(getLastTouched(a)); });
  var box = document.getElementById('archivedList');
  box.innerHTML = archived.length ? archived.map(archivedRowHtml).join('') : '<div class="empty-col">Nothing archived</div>';
  box.querySelectorAll('.detail-row').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      openModal(findCard(el.dataset.id));
    });
  });
  box.querySelectorAll('.detail-row-actions button').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var card = findCard(btn.dataset.id);
      card.frontmatter.pipeline.stage = STAGES[0];
      card.frontmatter.pipeline.reject_reason = '';
      patchCard(card).then(renderAll);
    });
  });
}

// ---------- modal ----------
function dotButtons(val) {
  var out = '';
  for (var i = 1; i <= 5; i++) out += '<button type="button" data-val="' + i + '" class="' + (i <= val ? 'filled' : '') + '"></button>';
  return out;
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  currentCard = null;
}

function applyStructuredFieldsToCard(card) {
  var fm = card.frontmatter;
  fm.title = document.getElementById('m-title').value;
  fm.type = document.getElementById('m-type').value;
  card.type = fm.type;
  fm.categories = document.getElementById('m-categories').value || null;
  fm.pipeline.stage = document.getElementById('m-stage').value;
  fm.pipeline.writing_effort = Number(document.getElementById('m-effort').dataset.val) || 0;
  fm.pipeline.verification_burden = Number(document.getElementById('m-verification').dataset.val) || 0;
  fm.pipeline.hold_until = document.getElementById('m-hold').value || '';
  var pubDateVal = document.getElementById('m-publish').value;
  var pubTimeVal = document.getElementById('m-publish-time').value;
  fm.pipeline.publish_date = pubDateVal ? (pubDateVal + (pubTimeVal ? 'T' + pubTimeVal : '')) : '';
  var rejectEl = document.getElementById('m-reject');
  if (rejectEl) fm.pipeline.reject_reason = rejectEl.value;
  card.body = document.getElementById('m-body').value;
}

function openModal(card) {
  if (!card) return;
  currentCard = card;
  var fm = card.frontmatter;
  var stage = getStage(card);
  var effort = getEffort(card), verification = getVerification(card);
  var stageOptions = STAGES.map(function (s) {
    return '<option value="' + s + '"' + (s === stage ? ' selected' : '') + '>' + s + '</option>';
  }).join('');

  var typeList = TYPES.indexOf(card.type) === -1 ? [card.type].concat(TYPES) : TYPES;
  var typeOptions = typeList.map(function (t) {
    return '<option value="' + t + '"' + (t === card.type ? ' selected' : '') + '>' + t + '</option>';
  }).join('');

  var categoriesOptions = '<option value="">(none)</option>' + SITE_CATEGORIES.map(function (c) {
    return '<option value="' + c + '"' + (c === fm.categories ? ' selected' : '') + '>' + c + '</option>';
  }).join('');

  var sourceLinks = '';
  var srcResearch = fm.pipeline.source_research;
  var srcIdea = fm.pipeline.source_idea;
  if (srcResearch) sourceLinks += '<div class="field"><label>Source research</label><span class="link-chip" data-goto="' + escapeHtml(srcResearch) + '" style="cursor:pointer; text-decoration:underline;">' + escapeHtml(srcResearch) + '</span></div>';
  if (srcIdea) sourceLinks += '<div class="field"><label>Source idea</label><span class="link-chip" data-goto="' + escapeHtml(srcIdea) + '" style="cursor:pointer; text-decoration:underline;">' + escapeHtml(srcIdea) + '</span></div>';

  document.getElementById('cardModal').innerHTML =
    '<h2>' + escapeHtml(getTitle(card)) + '</h2>' +
    '<div class="field"><label>Title</label><input type="text" id="m-title" value="' + escapeHtml(fm.title || '') + '"></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Type</label><select id="m-type">' + typeOptions + '</select></div>' +
    '<div class="field"><label>Stage</label><select id="m-stage">' + stageOptions + '</select></div>' +
    '</div>' +
    '<div class="field"><label>Categories</label><select id="m-categories">' + categoriesOptions + '</select></div>' +
    '<div class="field"><label>Source URL</label>' +
    (fm.pipeline.source_url ?
      '<a href="' + escapeHtml(fm.pipeline.source_url) + '" target="_blank" rel="noopener noreferrer" class="source-open-link">' + escapeHtml(fm.pipeline.source_url) + '</a>' :
      '<span class="field-empty">(none)</span>') +
    '</div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Writing effort</label><div class="dot-picker" id="m-effort" data-val="' + effort + '">' + dotButtons(effort) + '</div></div>' +
    '<div class="field"><label>Verification burden</label><div class="dot-picker" id="m-verification" data-val="' + verification + '">' + dotButtons(verification) + '</div></div>' +
    '</div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Hold until</label><input type="date" id="m-hold" value="' + normalizeDate(getHoldUntil(card)) + '"></div>' +
    '<div class="field"><label>Publish date</label><div class="field-row">' +
    '<input type="date" id="m-publish" value="' + normalizeDate(getPublishDate(card)) + '">' +
    '<select id="m-publish-time">' + timeOptionsHtml(getPublishTime(card)) + '</select>' +
    '</div></div>' +
    '</div>' +
    (stage === 'archived' ? '<div class="field"><label>Reject reason</label><input type="text" id="m-reject" value="' + escapeHtml(fm.pipeline.reject_reason || '') + '"></div>' : '') +
    sourceLinks +
    '<div class="field"><label>Body / notes</label><textarea id="m-body">' + escapeHtml(card.body || '') + '</textarea></div>' +
    '<button type="button" class="raw-toggle" id="rawToggle">Show raw frontmatter (YAML)</button>' +
    '<div class="field" id="rawBox" style="display:none;"><textarea id="m-raw" style="min-height:140px;"></textarea><button type="button" class="btn" id="rawApply">Apply raw YAML</button></div>' +
    '<div class="modal-actions">' +
    '<div class="left">' +
    (stage === STAGES[0] ? '<button class="btn accent-research" id="m-yay">Yay</button><button class="btn accent-danger" id="m-nay">Nay</button>' : '') +
    '<button class="btn" id="m-snooze">Not today</button>' +
    (PUBLISHED_ROOTS.indexOf(card.type) !== -1 && stage !== 'published' ? '<button class="btn accent-content" id="m-markpub">Mark as published</button>' : '') +
    '</div>' +
    '<div>' +
    '<button class="btn accent-danger" id="m-delete">Delete</button> ' +
    '<button class="btn" id="m-cancel">Cancel</button> ' +
    '<button class="btn accent-idea" id="m-save">Save</button>' +
    '</div>' +
    '</div>';

  document.getElementById('modalOverlay').classList.add('open');
  wireModalEvents(card);
}

function wireModalEvents(card) {
  document.querySelectorAll('.link-chip[data-goto]').forEach(function (el) {
    el.addEventListener('click', function () {
      var target = findCard(el.dataset.goto);
      if (target) openModal(target);
      else alert('That linked file wasn\'t found — it may have been moved or renamed.');
    });
  });
  document.querySelectorAll('#m-effort button, #m-verification button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var group = btn.parentElement;
      var val = Number(btn.dataset.val);
      group.dataset.val = val;
      Array.from(group.children).forEach(function (b) { b.classList.toggle('filled', Number(b.dataset.val) <= val); });
    });
  });

  document.getElementById('rawToggle').addEventListener('click', function () {
    var box = document.getElementById('rawBox');
    var isOpen = box.style.display !== 'none';
    if (!isOpen) document.getElementById('m-raw').value = jsyaml.dump(card.frontmatter);
    box.style.display = isOpen ? 'none' : 'block';
  });
  document.getElementById('rawApply').addEventListener('click', function () {
    try {
      var parsed = jsyaml.load(document.getElementById('m-raw').value) || {};
      if (!parsed.pipeline || typeof parsed.pipeline !== 'object') throw new Error('frontmatter must keep a pipeline: block');
      Object.keys(card.frontmatter).forEach(function (k) { delete card.frontmatter[k]; });
      Object.assign(card.frontmatter, parsed);
      openModal(card);
    } catch (e) {
      alert('Could not parse YAML: ' + e.message);
    }
  });

  document.getElementById('m-cancel').addEventListener('click', closeModal);
  document.getElementById('m-save').addEventListener('click', function () {
    applyStructuredFieldsToCard(card);
    patchCard(card).then(function () { closeModal(); renderAll(); });
  });
  document.getElementById('m-snooze').addEventListener('click', function () {
    applyStructuredFieldsToCard(card);
    card.frontmatter.pipeline.last_touched = new Date().toISOString();
    patchCard(card).then(function () { closeModal(); renderAll(); });
  });
  document.getElementById('m-delete').addEventListener('click', function () {
    if (!confirm('Delete this file entirely? This cannot be undone.')) return;
    fetch('/api/cards/' + card.id, { method: 'DELETE' }).then(function () {
      cards = cards.filter(function (c) { return c.id !== card.id; });
      closeModal(); renderAll();
    });
  });
  var yay = document.getElementById('m-yay');
  if (yay) yay.addEventListener('click', function () {
    applyStructuredFieldsToCard(card);
    card.frontmatter.pipeline.stage = STAGES[1] || STAGES[0];
    patchCard(card).then(function () { closeModal(); renderAll(); });
  });
  var nay = document.getElementById('m-nay');
  if (nay) nay.addEventListener('click', function () {
    applyStructuredFieldsToCard(card);
    if (!card.frontmatter.pipeline.reject_reason) {
      card.frontmatter.pipeline.reject_reason = prompt('Why nay? (optional)') || '';
    }
    card.frontmatter.pipeline.stage = 'archived';
    patchCard(card).then(function () { closeModal(); renderAll(); });
  });
  var markPub = document.getElementById('m-markpub');
  if (markPub) markPub.addEventListener('click', function () {
    applyStructuredFieldsToCard(card);
    var pub = card.frontmatter.pipeline.publish_date;
    if (!pub) { alert('Set a publish date first.'); return; }
    if (PUBLISHED_ROOTS.indexOf(card.type) === -1) { alert('Only post/guide/docs cards can be published.'); return; }
    // Required site fields must be filled first (see ensurePublishFieldsFilled).
    ensurePublishFieldsFilled(card, function () {
      card.frontmatter.date = pub;
      card.frontmatter.published = true;
      card.frontmatter.pipeline.stage = 'published';
      // Physically move the file out of the pipeline and into the matching
      // published root (post/guide/docs) — publishing is a real move, keyed
      // off the card's own type, not just a status flip.
      fetch('/api/cards/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: card.id, toRoot: card.type, frontmatter: card.frontmatter, body: card.body })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'move failed'); });
        return r.json();
      }).then(function () { closeModal(); loadCards(); })
        .catch(function (e) { alert('Could not publish: ' + e.message); });
    });
  });
}

function openNewCardModal() {
  var typeOptions = (TYPES.length ? TYPES : ['research', 'idea', 'post']).map(function (t) {
    return '<option value="' + t + '">' + t + '</option>';
  }).join('');
  document.getElementById('cardModal').innerHTML =
    '<h2>New card</h2>' +
    '<div class="field"><label>Type</label><select id="n-type">' + typeOptions + '</select></div>' +
    '<div class="field"><label>Title</label><input type="text" id="n-title" placeholder="Working title"></div>' +
    '<div class="field"><label>Notes / body</label><textarea id="n-body"></textarea></div>' +
    '<div class="modal-actions"><div class="left"></div><div>' +
    '<button class="btn" id="n-cancel">Cancel</button> ' +
    '<button class="btn accent-idea" id="n-create">Create</button>' +
    '</div></div>';
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('n-cancel').addEventListener('click', closeModal);
  document.getElementById('n-create').addEventListener('click', function () {
    var type = document.getElementById('n-type').value;
    var title = document.getElementById('n-title').value.trim() || 'Untitled';
    var body = document.getElementById('n-body').value;
    // New cards always land in the pipeline root — the server applies the
    // full standard frontmatter shape (site fields + nested pipeline block)
    // regardless of type, so the client just sends the basics.
    fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: type, title: title, body: body })
    }).then(function (r) { return r.json(); }).then(function () { closeModal(); loadCards(); });
  });
}

// ---------- init ----------
function init() {
  fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
    STAGES = cfg.stages;
    TYPES = cfg.types || [];
    SITE_CATEGORIES = cfg.siteCategories || [];
    loadCards();
  });

  document.querySelectorAll('nav.tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('nav.tabs button').forEach(function (b) { b.classList.toggle('active', b === btn); });
      document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + btn.dataset.view); });
    });
  });
  document.getElementById('calPrev').addEventListener('click', function () { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
  document.getElementById('calNext').addEventListener('click', function () { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });
  document.getElementById('calToday').addEventListener('click', function () {
    calMonth = new Date(); calMonth.setDate(1); calMonth.setHours(0, 0, 0, 0);
    renderCalendar();
  });
  document.getElementById('surpriseBtn').addEventListener('click', function () {
    var candidates = cards.filter(function (c) {
      return !isHeld(c) && !isScheduled(c) && getStage(c) !== STAGES[0] && getStage(c) !== 'archived';
    });
    if (!candidates.length) { alert('Nothing available to surprise you with right now.'); return; }
    candidates.sort(function (a, b) { return (getEffort(a) + getVerification(a)) - (getEffort(b) + getVerification(b)); });
    openModal(candidates[0]);
  });
  document.getElementById('newCardBtn').addEventListener('click', openNewCardModal);
  document.getElementById('modalOverlay').addEventListener('click', function (e) {
    if (e.target.id === 'modalOverlay') closeModal();
  });
}

document.addEventListener('DOMContentLoaded', init);
