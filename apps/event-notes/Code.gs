/**
 * @OnlyCurrentDoc
 *
 * Suvera Event Notes: a phone-friendly web app for logging conversations
 * at in-person events, straight into the guest-list Google Sheet.
 *
 * Paste this into the guest-list sheet's script (Extensions → Apps Script)
 * alongside Index.html. See apps/event-notes/README.md for the deploy steps.
 *
 * Reads:  the "Guests" tab (Full name | Email | Practice / organisation | Role)
 * Writes: the "Notes" tab (created automatically on first save), one row per
 *         conversation. It only ever appends, so the team saving at the same
 *         moment can't overwrite each other.
 *         The "By guest" tab: one row per guest with every note combined,
 *         rebuilt after each save (and when Notes is edited by hand), for
 *         follow-up after the event.
 *
 * Optional PIN: Project Settings → Script properties → add ACCESS_PIN.
 * Leave it unset for no PIN. It is kept out of this file on purpose, so the
 * PIN never ends up in git.
 */

const CONFIG = {
  EVENT_NAME: 'Proactive by Default',
  GUESTS_SHEET: 'Guests',
  NOTES_SHEET: 'Notes',
  BY_GUEST_SHEET: 'By guest',
  // Team names shown as tap-to-pick buttons on first launch.
  // Leave empty to let people type their own name.
  // (shown A-Z whatever order they're typed in here)
  TEAM: ['Aleena', 'Ben', 'Caitlin', 'Camilla', 'CJ', 'Ellena', 'Ivan', 'Ram', 'Roland', 'Ryan', 'Ryzard', 'Will'],
  // One-tap tags shown under the note box. Edit freely.
  QUICK_TAGS: ['Wants a demo', 'Follow up', 'Hot lead', 'Send info', 'Existing customer'],
};

const BY_GUEST_HEADERS = [
  'Full name', 'Practice / organisation', 'Role', 'Email', 'Conversations',
  'Spoken to by', 'Tags', 'Last spoken', 'All notes (newest first)', 'Walk-in',
];

const NOTES_HEADERS = [
  'Timestamp', 'Team member', 'Full name', 'Email', 'Practice / organisation',
  'Role', 'Tags', 'Note', 'Walk-in', 'Guest key', 'Entry ID',
];

/* ------------------------------------------------------------------ */
/* Web app entry point                                                 */
/* ------------------------------------------------------------------ */

/**
 * Personal links (?me=Caitlin&k=PIN) carry the person's name and the PIN, so
 * the phone never has to remember them. That matters on iPhone: a
 * home-screen web app loses this page's saved data every time it's closed.
 * The guest list and notes are included in this first response, which saves
 * two more trips to Google before anything shows.
 */
function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  t.boot = bootJson_((e && e.parameter) || {});
  return t.evaluate()
    .setTitle('Suvera Event Notes')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('mobile-web-app-capable', 'yes');
}

function bootJson_(params) {
  const config = getConfig();
  let me = clean_(params.me, 80);
  if (me && config.team.length) {
    me = config.team.filter(function (n) { return n.toLowerCase() === me.toLowerCase(); })[0] || '';
  }
  const pin = clean_(params.k, 40);
  const pinOk = !config.pinRequired || (pin !== '' && pin === getPin_());
  const boot = {
    config: config,
    me: me,
    pin: pinOk ? pin : '',
    data: pinOk ? getData(pin) : null,
  };
  // Safe to drop inside a <script> tag.
  return JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/* ------------------------------------------------------------------ */
/* Functions called from the page via google.script.run               */
/* ------------------------------------------------------------------ */

/** Config the page needs before sign-in. Contains no guest data. */
function getConfig() {
  return {
    eventName: CONFIG.EVENT_NAME,
    team: CONFIG.TEAM.slice().sort(function (a, b) {
      return a.localeCompare(b, 'en', { sensitivity: 'base' });
    }),
    quickTags: CONFIG.QUICK_TAGS,
    pinRequired: Boolean(getPin_()),
  };
}

/** Guest list + every note so far. The page polls this to stay in sync. */
function getData(pin) {
  checkPin_(pin);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const guests = readGuests_(ss);
  const notes = readNotes_(ss);

  // Walk-ins (people added from the app who aren't on the Guests tab)
  // show up in search too, so a colleague can find and add to them.
  const known = new Set(guests.map(function (g) { return g.key; }));
  notes.forEach(function (n) {
    if (!known.has(n.key)) {
      known.add(n.key);
      guests.push({
        key: n.key, name: n.name, email: n.email,
        practice: n.practice, role: n.role, walkin: true,
      });
    }
  });

  return { guests: guests, notes: notes, serverTime: Date.now() };
}

/** Append one conversation note. Safe to retry (deduped on entryId). */
function saveNote(pin, p) {
  checkPin_(pin);
  p = p || {};
  const team = clean_(p.team, 80);
  const name = clean_(p.name, 200);
  const note = clean_(p.note, 5000);
  const tags = Array.isArray(p.tags) ? p.tags.map(function (t) { return clean_(t, 60); }).filter(String) : [];
  const entryId = clean_(p.entryId, 64);
  if (!team) throw new Error('INVALID: missing team member');
  if (!name) throw new Error('INVALID: missing guest name');
  if (!note && !tags.length) throw new Error('INVALID: empty note');
  if (!entryId) throw new Error('INVALID: missing entryId');

  const email = clean_(p.email, 200).toLowerCase();
  const key = guestKey_(email, name);

  // Notes saved offline and sent later keep the time they were written.
  let ts = new Date();
  const clientTs = Number(p.clientTs);
  if (clientTs && Math.abs(Date.now() - clientTs) < 48 * 3600 * 1000) ts = new Date(clientTs);

  // Many phones can save at once. Each save waits its turn for this lock, and
  // holds it only for the quick append, so nobody's row is lost or
  // overwritten. If the wait ever times out, the phone keeps the note and
  // retries, and entryId stops a retry from writing it twice.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let duplicate = false;
  try {
    const sheet = ensureNotesSheet_(SpreadsheetApp.getActiveSpreadsheet());
    const last = sheet.getLastRow();
    if (last > 1) {
      const ids = sheet.getRange(2, NOTES_HEADERS.length, last - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === entryId) { duplicate = true; break; }
      }
    }
    if (!duplicate) {
      sheet.appendRow([
        ts, team, name, email, clean_(p.practice, 200), clean_(p.role, 200),
        tags.join(', '), note, p.walkin ? 'Yes' : '', key, entryId,
      ].map(safeCell_));
      SpreadsheetApp.flush();
    }
  } finally {
    lock.releaseLock();
  }
  // The note is in the sheet at this point. The summary tab is refreshed
  // outside the save lock so it never holds up anyone else's save, and a
  // failure there must not make the phone think the note wasn't saved.
  try {
    requestByGuestRebuild_(SpreadsheetApp.getActiveSpreadsheet());
  } catch (err) {
    console.error('By guest rebuild failed: ' + err);
  }
  return { ok: true, duplicate: duplicate, savedAt: Date.now() };
}

/**
 * Rebuild "By guest" without making simultaneous saves queue up behind it.
 * Each save marks the tab out of date. Only one rebuild runs at a time; it
 * goes round again if more notes arrived while it was running. Saves that
 * find a rebuild already running return straight away, because that rebuild
 * will include their note.
 */
function requestByGuestRebuild_(ss) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('BY_GUEST_DIRTY', Utilities.getUuid());
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(100)) return;
  try {
    for (let i = 0; i < 5; i++) {
      const mark = props.getProperty('BY_GUEST_DIRTY');
      rebuildByGuest_(ss);
      if (props.getProperty('BY_GUEST_DIRTY') === mark) break;
    }
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* "By guest" follow-up tab                                             */
/* ------------------------------------------------------------------ */

/** Sheet menu, so the summary can be refreshed by hand. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Event notes')
    .addItem('Rebuild "By guest" tab', 'rebuildByGuest')
    .addItem('Make personal team links', 'makeTeamLinks')
    .addToUi();
}

/**
 * Sheet menu: asks for the web app link and writes a "Team links" tab with
 * one personal link per team member (name + PIN built in). Send each person
 * their own link to add to their home screen.
 */
function makeTeamLinks() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Make personal team links',
    'Paste the web app link (Deploy → Manage deployments → Web app URL, ends in /exec):',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const base = String(res.getResponseText() || '').trim().split('?')[0];
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(base)) {
    ui.alert('That doesn\'t look like the web app link. It should start with https://script.google.com/ and end in /exec.');
    return;
  }
  const pin = getPin_();
  const team = getConfig().team;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Team links');
  if (!sheet) sheet = ss.insertSheet('Team links');
  sheet.clearContents();
  const rows = [['Name', 'Personal link (send privately: it includes the PIN)']].concat(team.map(function (name) {
    return [name, base + '?me=' + encodeURIComponent(name) + (pin ? '&k=' + encodeURIComponent(pin) : '')];
  }));
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 720);
  ss.setActiveSheet(sheet);
  ui.alert('Done: ' + team.length + ' links in the "Team links" tab. Each person opens theirs in Safari (iPhone) or Chrome (Android), then Add to Home Screen.');
}

/** Keep "By guest" in step when someone fixes a typo in Notes or Guests. */
function onEdit(e) {
  const name = e && e.range && e.range.getSheet().getName();
  if (name === CONFIG.NOTES_SHEET || name === CONFIG.GUESTS_SHEET) {
    rebuildByGuest_(e.source);
  }
}

function rebuildByGuest() {
  rebuildByGuest_(SpreadsheetApp.getActiveSpreadsheet());
}

/**
 * One row per guest: everyone on the Guests tab plus walk-ins. People with
 * notes are listed first (most conversations, then most recent), then the
 * rest alphabetically, so the bottom of the tab is who nobody reached.
 */
function rebuildByGuest_(ss) {
  const tz = ss.getSpreadsheetTimeZone();
  const guests = readGuests_(ss);
  const notes = readNotes_(ss);
  const byKey = {};
  const order = [];
  guests.forEach(function (g) { byKey[g.key] = { g: g, notes: [] }; order.push(g.key); });
  notes.forEach(function (n) {
    if (!byKey[n.key]) {
      byKey[n.key] = { g: { name: n.name, email: n.email, practice: n.practice, role: n.role, walkin: true }, notes: [] };
      order.push(n.key);
    }
    byKey[n.key].notes.push(n);
  });

  const rows = order.map(function (k) {
    const entry = byKey[k];
    const g = entry.g;
    const ns = entry.notes.slice().sort(function (a, b) { return b.ts - a.ts; });
    const team = unique_(ns.map(function (n) { return n.team; }).reverse());
    const tags = unique_([].concat.apply([], ns.map(function (n) {
      return String(n.tags || '').split(/,\s*/);
    })));
    const text = ns.map(function (n) {
      const when = n.ts ? Utilities.formatDate(new Date(n.ts), tz, 'HH:mm') : '';
      return when + ' ' + n.team + ': ' + (n.tags ? '[' + n.tags + '] ' : '') + n.note;
    }).join('\n');
    return {
      count: ns.length,
      last: ns.length ? ns[0].ts : 0,
      cells: [
        g.name, g.practice, g.role, g.email, ns.length,
        team.join(', '), tags.join(', '), ns.length && ns[0].ts ? new Date(ns[0].ts) : '',
        text, g.walkin ? 'Yes' : '',
      ].map(safeCell_),
    };
  });
  rows.sort(function (a, b) {
    if (!!a.count !== !!b.count) return a.count ? -1 : 1;
    if (a.count !== b.count) return b.count - a.count;
    if (a.last !== b.last) return b.last - a.last;
    return String(a.cells[0]).localeCompare(String(b.cells[0]));
  });

  let sheet = ss.getSheetByName(CONFIG.BY_GUEST_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.BY_GUEST_SHEET);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 170);
    sheet.setColumnWidth(2, 220);
    sheet.setColumnWidth(3, 160);
    sheet.setColumnWidth(4, 200);
    sheet.setColumnWidth(5, 100);
    sheet.setColumnWidth(6, 150);
    sheet.setColumnWidth(7, 180);
    sheet.setColumnWidth(8, 110);
    sheet.setColumnWidth(9, 520);
  }
  sheet.clearContents();
  const values = [BY_GUEST_HEADERS].concat(rows.map(function (r) { return r.cells; }));
  sheet.getRange(1, 1, values.length, BY_GUEST_HEADERS.length).setValues(values);
  sheet.getRange(1, 1, 1, BY_GUEST_HEADERS.length).setFontWeight('bold');
  sheet.getRange(2, 8, Math.max(values.length - 1, 1), 1).setNumberFormat('ddd d mmm hh:mm');
  sheet.getRange(2, 9, Math.max(values.length - 1, 1), 1).setWrap(true);
  sheet.getRange(2, 1, Math.max(values.length - 1, 1), BY_GUEST_HEADERS.length).setVerticalAlignment('top');
}

function unique_(arr) {
  const seen = {};
  return arr.filter(function (x) {
    x = String(x || '').trim();
    if (!x || seen[x]) return false;
    seen[x] = 1;
    return true;
  }).map(function (x) { return String(x).trim(); });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function getPin_() {
  return String(PropertiesService.getScriptProperties().getProperty('ACCESS_PIN') || '').trim();
}

function checkPin_(pin) {
  const expected = getPin_();
  if (expected && String(pin || '').trim() !== expected) throw new Error('PIN_INVALID');
}

function readGuests_(ss) {
  const sheet = ss.getSheetByName(CONFIG.GUESTS_SHEET) || ss.getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  const header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const col = function (names, fallback) {
    for (let i = 0; i < names.length; i++) {
      const idx = header.indexOf(names[i]);
      if (idx !== -1) return idx;
    }
    return fallback;
  };
  const cName = col(['full name', 'name'], 0);
  const cEmail = col(['email', 'email address'], 1);
  const cOrg = col(['practice / organisation', 'practice', 'organisation', 'organization'], 2);
  const cRole = col(['role', 'job title'], 3);

  const out = [];
  const seen = new Set();
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const name = String(row[cName] || '').trim();
    if (!name) continue;
    const email = String(row[cEmail] || '').trim().toLowerCase();
    const key = guestKey_(email, name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key: key, name: name, email: email,
      practice: String(row[cOrg] || '').trim(),
      role: String(row[cRole] || '').trim(),
      walkin: false,
    });
  }
  return out;
}

function readNotes_(ss) {
  const sheet = ss.getSheetByName(CONFIG.NOTES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, NOTES_HEADERS.length).getValues();
  return values
    .filter(function (r) { return r[2]; })
    .map(function (r) {
      const ts = r[0] instanceof Date ? r[0].getTime() : (Date.parse(r[0]) || 0);
      const email = String(r[3] || '').trim().toLowerCase();
      const name = String(r[2]).trim();
      return {
        ts: ts,
        team: String(r[1] || ''),
        name: name,
        email: email,
        practice: String(r[4] || ''),
        role: String(r[5] || ''),
        tags: String(r[6] || ''),
        note: String(r[7] || ''),
        walkin: String(r[8] || '') === 'Yes',
        key: String(r[9] || '') || guestKey_(email, name),
        entryId: String(r[10] || ''),
      };
    });
}

function ensureNotesSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.NOTES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.NOTES_SHEET);
    sheet.getRange(1, 1, 1, NOTES_HEADERS.length).setValues([NOTES_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('ddd d mmm hh:mm');
    sheet.setColumnWidth(1, 130);
    sheet.setColumnWidth(3, 170);
    sheet.setColumnWidth(5, 220);
    sheet.setColumnWidth(7, 160);
    sheet.setColumnWidth(8, 420);
    sheet.getRange('H:H').setWrap(true);
    sheet.hideColumns(10, 2); // Guest key + Entry ID are plumbing
  }
  return sheet;
}

/** Same key the page uses: email if we have one, else the normalised name. */
function guestKey_(email, name) {
  if (email) return String(email).toLowerCase();
  return 'name:' + String(name || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);
}

/** Stop typed text like "=HYPERLINK(...)" or "+44..." being run as a formula. */
function safeCell_(v) {
  return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;
}
