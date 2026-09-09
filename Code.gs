/**
 * Green Buildings Project Repository — prototype backend
 *
 * Architecture
 *   Google Sheet (tab "Projects")  ->  data store
 *   Apps Script (this file)        ->  reads the sheet, serves JSON and the UI
 *   Index.html                     ->  front end, embedded in Google Sites via the web app URL
 *
 * Two entry points, one deployment:
 *   GET <web app url>                -> the HTML interface
 *   GET <web app url>?format=json    -> the project list as JSON
 *
 * Author: Alistair Nhiwatiwa (github.com/Onesayi)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

var CONFIG = {
  sheetName: 'Projects',
  // Cache the parsed sheet so repeated page loads do not re-read it every time.
  cacheSeconds: 300,
  cacheKey: 'projects_v1',
  // Optional. Set GEMINI_API_KEY in Project Settings > Script Properties to
  // enable the natural-language query box. Left unset, the UI hides that panel.
  geminiModel: 'gemini-2.0-flash',
  geminiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/'
};

// ---------------------------------------------------------------------------
// Web entry point
// ---------------------------------------------------------------------------

function doGet(e) {
  var params = (e && e.parameter) || {};

  if (params.format === 'json') {
    var projects = getProjects();
    return jsonResponse({
      ok: true,
      count: projects.length,
      generatedAt: new Date().toISOString(),
      projects: projects
    });
  }

  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Green Buildings Project Repository')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // required to embed in Google Sites
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/**
 * Reads the Projects tab and returns an array of objects keyed by the header row.
 * Header cells are normalised to lower snake_case so the sheet stays human-editable:
 * "Floor Area m2" in the sheet becomes floor_area_m2 in the JSON.
 */
function getProjects() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CONFIG.cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.sheetName);
  if (!sheet) {
    throw new Error('Sheet tab "' + CONFIG.sheetName + '" not found.');
  }

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return [];
  }

  var headers = values[0].map(normaliseHeader);
  var projects = [];

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.every(isBlank)) {
      continue; // skip empty rows rather than emitting empty records
    }

    var project = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      project[headers[c]] = normaliseCell(row[c]);
    }
    projects.push(project);
  }

  cache.put(CONFIG.cacheKey, JSON.stringify(projects), CONFIG.cacheSeconds);
  return projects;
}

/** Called from the front end via google.script.run. */
function getRepositoryPayload() {
  var projects = getProjects();
  return {
    projects: projects,
    facets: buildFacets(projects),
    aiEnabled: Boolean(getGeminiKey())
  };
}

/** Distinct values for the filter dropdowns, sorted, blanks dropped. */
function buildFacets(projects) {
  var fields = ['category', 'country', 'status', 'certification'];
  var facets = {};

  fields.forEach(function (field) {
    var seen = {};
    projects.forEach(function (p) {
      var v = p[field];
      if (v) seen[v] = true;
    });
    facets[field] = Object.keys(seen).sort();
  });

  return facets;
}

/** Clears the cache. Run this after editing the sheet if you do not want to wait. */
function refreshCache() {
  CacheService.getScriptCache().remove(CONFIG.cacheKey);
  return getProjects().length + ' projects reloaded.';
}

// ---------------------------------------------------------------------------
// Optional: natural-language query over the repository (Gemini via UrlFetchApp)
// ---------------------------------------------------------------------------

function getGeminiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

/**
 * Answers a plain-English question using only the repository rows as context.
 *
 * Deliberate constraints:
 *  - only the fields already published in the JSON feed are sent, nothing else
 *    from the spreadsheet or the account
 *  - the model is told to answer from the supplied rows and to say so when the
 *    answer is not in them, so it does not invent projects
 *  - the answer is returned labelled as generated, for a human to check before
 *    it goes to a partner
 */
function askRepository(question) {
  var key = getGeminiKey();
  if (!key) {
    return { ok: false, error: 'No API key configured.' };
  }
  if (!question || !question.trim()) {
    return { ok: false, error: 'Empty question.' };
  }

  var projects = getProjects();
  var context = projects.map(function (p) {
    return [p.id, p.name, p.country, p.category, p.certification, p.status, p.year, p.summary]
      .filter(Boolean).join(' | ');
  }).join('\n');

  var prompt =
    'You are answering questions about a repository of green building projects.\n' +
    'Use ONLY the rows below. If the answer is not in them, say so plainly.\n' +
    'Cite the project id or ids you used. Answer in under 120 words.\n\n' +
    'ROWS:\n' + context + '\n\nQUESTION: ' + question;

  var url = CONFIG.geminiEndpoint + CONFIG.geminiModel + ':generateContent';

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    }),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    return { ok: false, error: 'Gemini API returned ' + code };
  }

  var body = JSON.parse(response.getContentText());
  var text = body &&
    body.candidates &&
    body.candidates[0] &&
    body.candidates[0].content &&
    body.candidates[0].content.parts &&
    body.candidates[0].content.parts[0] &&
    body.candidates[0].content.parts[0].text;

  if (!text) {
    return { ok: false, error: 'No answer returned.' };
  }

  return { ok: true, answer: text.trim(), generated: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normaliseCell(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (typeof v === 'string') {
    return v.trim();
  }
  return v;
}

function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

/** Lets Index.html pull in shared partials if the prototype grows. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
