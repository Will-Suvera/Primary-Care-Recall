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

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'suvera-contract-filer' }))
    .setMimeType(ContentService.MimeType.JSON);
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
