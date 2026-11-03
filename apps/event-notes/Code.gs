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
 *         conversation. It only ever appends, so 7 people saving at the same
 *         moment can't overwrite each other.
 *
 * Optional PIN: Project Settings → Script properties → add ACCESS_PIN.
 * Leave it unset for no PIN. It is kept out of this file on purpose, so the
 * PIN never ends up in git.
 */

const CONFIG = {
  EVENT_NAME: 'Proactive by Default',
  GUESTS_SHEET: 'Guests',
  NOTES_SHEET: 'Notes',
  // Team names shown as tap-to-pick buttons on first launch.
  // Leave empty to let people type their own name.
  TEAM: [],
  // One-tap tags shown under the note box. Edit freely.
  QUICK_TAGS: ['Wants a demo', 'Follow up', 'Hot lead', 'Send info', 'Existing customer'],
};

const NOTES_HEADERS = [
  'Timestamp', 'Team member', 'Full name', 'Email', 'Practice / organisation',
  'Role', 'Tags', 'Note', 'Walk-in', 'Guest key', 'Entry ID',
];

/* ------------------------------------------------------------------ */
/* Web app entry point                                                 */
/* ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Suvera Event Notes')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('mobile-web-app-capable', 'yes');
}

/* ------------------------------------------------------------------ */
/* Functions called from the page via google.script.run               */
/* ------------------------------------------------------------------ */

/** Config the page needs before sign-in. Contains no guest data. */
function getConfig() {
  return {
    eventName: CONFIG.EVENT_NAME,
    team: CONFIG.TEAM,
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

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = ensureNotesSheet_(SpreadsheetApp.getActiveSpreadsheet());
    const last = sheet.getLastRow();
    if (last > 1) {
      const ids = sheet.getRange(2, NOTES_HEADERS.length, last - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === entryId) return { ok: true, duplicate: true };
      }
    }
    sheet.appendRow([
      ts, team, name, email, clean_(p.practice, 200), clean_(p.role, 200),
      tags.join(', '), note, p.walkin ? 'Yes' : '', key, entryId,
    ].map(safeCell_));
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
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
