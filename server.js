#!/usr/bin/env node
/**
 * PerfettoHub — a local hub for storing, naming, and viewing Perfetto traces.
 *
 * Zero-dependency Node.js server:
 *   - Serves the static frontend from ./public
 *   - REST API for uploading, listing, renaming, and deleting traces
 *   - Trace files and metadata persist under ./data
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3003;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const TRACES_DIR = path.join(DATA_DIR, 'traces');
const DB_PATH = path.join(DATA_DIR, 'traces.json');
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

fs.mkdirSync(TRACES_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Metadata store (JSON file on disk)
// ---------------------------------------------------------------------------

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { traces: [] };
  }
}

let db = loadDb();

async function saveDb() {
  const tmp = DB_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
  await fsp.rename(tmp, DB_PATH);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function findTrace(id) {
  return db.traces.find((t) => t.id === id);
}

function tracePath(trace) {
  return path.join(TRACES_DIR, trace.storedFile);
}

function sanitizeFileName(name) {
  return (name || 'trace').replace(/[^\w.\-]+/g, '_').slice(0, 128) || 'trace';
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleUpload(req, res, url) {
  const rawName = url.searchParams.get('name') || '';
  const fileName = url.searchParams.get('filename') || 'trace';
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (body.length === 0) {
    return sendJson(res, 400, { error: 'Empty upload' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const storedFile = `${id}-${sanitizeFileName(fileName)}`;
  await fsp.writeFile(path.join(TRACES_DIR, storedFile), body);

  const trace = {
    id,
    name: rawName.trim() || fileName,
    originalFileName: fileName,
    storedFile,
    sizeBytes: body.length,
    uploadedAt: new Date().toISOString(),
  };
  db.traces.unshift(trace);
  await saveDb();
  sendJson(res, 201, trace);
}

async function handleRename(req, res, id) {
  const trace = findTrace(id);
  if (!trace) return sendJson(res, 404, { error: 'Trace not found' });
  const body = await readBody(req, 64 * 1024);
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!name) return sendJson(res, 400, { error: 'Name must be a non-empty string' });
  trace.name = name.slice(0, 200);
  await saveDb();
  sendJson(res, 200, trace);
}

async function handleDelete(res, id) {
  const idx = db.traces.findIndex((t) => t.id === id);
  if (idx === -1) return sendJson(res, 404, { error: 'Trace not found' });
  const [trace] = db.traces.splice(idx, 1);
  await saveDb();
  await fsp.unlink(tracePath(trace)).catch(() => {});
  sendJson(res, 200, { ok: true });
}

function handleFile(req, res, id, download) {
  const trace = findTrace(id);
  if (!trace) return sendJson(res, 404, { error: 'Trace not found' });
  const filePath = tracePath(trace);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'Trace file missing on disk' });
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
  };
  if (download) {
    headers['Content-Disposition'] =
      `attachment; filename="${sanitizeFileName(trace.originalFileName)}"`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/traces' && req.method === 'GET') {
      return sendJson(res, 200, { traces: db.traces });
    }
    if (pathname === '/api/traces' && req.method === 'POST') {
      return await handleUpload(req, res, url);
    }

    const m = pathname.match(/^\/api\/traces\/([a-f0-9]+)(\/file)?$/);
    if (m) {
      const [, id, isFile] = m;
      if (isFile && req.method === 'GET') {
        return handleFile(req, res, id, url.searchParams.get('download') === '1');
      }
      if (!isFile && req.method === 'PATCH') return await handleRename(req, res, id);
      if (!isFile && req.method === 'DELETE') return await handleDelete(res, id);
      if (!isFile && req.method === 'GET') {
        const trace = findTrace(id);
        return trace
          ? sendJson(res, 200, trace)
          : sendJson(res, 404, { error: 'Trace not found' });
      }
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Unknown API route' });
    }

    return serveStatic(res, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (!res.headersSent) sendJson(res, status, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`PerfettoHub running at http://localhost:${PORT}`);
});
