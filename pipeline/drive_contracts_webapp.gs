/**
 * Suvera contract filer — Google Apps Script web app.
 *
 * Deployed by Will (Deploy > New deployment > Web app, Execute as: Me,
 * Who has access: Anyone). The contract sync POSTs a signed PDF here; the
 * script files it under T&C Contracts / 2. Signed Contracts (Partners) /
 * <Customer> (creating the folder if needed) and returns the Drive links.
 * Files end up owned by Will, so no service account needs folder access.
 *
 * Script Properties (Project Settings > Script Properties):
 *   SECRET  — shared secret; the sync sends it as "secret" in the JSON body
 *   PARENT  — optional; defaults to the Signed Contracts (Partners) folder id
 */
var DEFAULT_PARENT = '1M8tBbnYdgVDHtKuFrmhDy1dz0II6sCZF';

/**
 * GET ?action=list&secret=…      -> DocuSign "Completed:" emails from the last 60 days
 *                                   (id, subject, date, attachment names)
 * GET ?action=fetch&secret=…&msg=<id> -> that email's contract PDF + DocuSign Summary
 *                                   certificate, base64 (the sync reads the envelope
 *                                   id from the Summary and runs the full chain)
 * GET (no action)                -> health check
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.action) {
    return reply({ ok: true, service: 'suvera-contract-filer' });
  }
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET') || p.secret !== props.getProperty('SECRET')) {
    return reply({ error: 'unauthorised' });
  }
  if (p.action === 'list') {
    var out = [];
    var threads = GmailApp.search('from:docusign.net subject:"Completed:" newer_than:60d', 0, 40);
    threads.forEach(function (t) {
      t.getMessages().forEach(function (m) {
        if (m.getFrom().indexOf('docusign.net') === -1 || m.getSubject().indexOf('Completed:') !== 0) return;
        var names = m.getAttachments().map(function (a) { return a.getName(); });
        if (!names.some(function (n) { return /\.pdf$/i.test(n) && n !== 'Summary.pdf'; })) return;
        out.push({ id: m.getId(), subject: m.getSubject(), date: m.getDate().toISOString(), attachments: names });
      });
    });
    return reply({ messages: out });
  }
  if (p.action === 'fetch' && p.msg) {
    var msg = GmailApp.getMessageById(p.msg);
    var res = { id: msg.getId(), subject: msg.getSubject(), date: msg.getDate().toISOString(), pdf_base64: '', summary_base64: '', filename: '' };
    msg.getAttachments().forEach(function (a) {
      if (!/\.pdf$/i.test(a.getName())) return;
      if (a.getName() === 'Summary.pdf') res.summary_base64 = Utilities.base64Encode(a.getBytes());
      else if (!res.pdf_base64) { res.pdf_base64 = Utilities.base64Encode(a.getBytes()); res.filename = a.getName(); }
    });
    return reply(res);
  }
  return reply({ error: 'unknown action' });
}

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return reply({ error: 'bad json' }); }
  if (!props.getProperty('SECRET') || body.secret !== props.getProperty('SECRET')) {
    return reply({ error: 'unauthorised' });
  }
  if (!body.customer || !body.filename || !body.pdf_base64) {
    return reply({ error: 'customer, filename and pdf_base64 are required' });
  }
  var parent = DriveApp.getFolderById(props.getProperty('PARENT') || DEFAULT_PARENT);
  var folder = findOrCreateFolder(parent, body.customer);

  // idempotent: a file already carrying this envelope id is returned, not duplicated
  var existing = null;
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (body.envelope_id && f.getName().indexOf(body.envelope_id) !== -1) { existing = f; break; }
  }
  var file = existing || folder.createFile(
    Utilities.newBlob(Utilities.base64Decode(body.pdf_base64), 'application/pdf', body.filename));
  return reply({ folder_url: folder.getUrl(), file_url: file.getUrl(), file_id: file.getId(),
                 created: !existing });
}

// "Wistaria & Milford Surgeries" and "Wistaria and Milford Surgeries" are the
// same customer: compare folder names loosely before creating a new one.
function normName(s) {
  return String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|ltd|limited|surgery|surgeries|practice|medical|centre|center|health|group)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function findOrCreateFolder(parent, name) {
  var exact = parent.getFoldersByName(name);
  if (exact.hasNext()) return exact.next();
  var want = normName(name), it = parent.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    if (normName(f.getName()) === want) return f;
  }
  return parent.createFolder(name);
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
