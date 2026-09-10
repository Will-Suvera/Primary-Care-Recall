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

function findOrCreateFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
