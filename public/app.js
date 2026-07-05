/* PerfettoHub frontend: drag & drop uploads, trace history, embedded viewer. */

const PERFETTO_ORIGIN = 'https://ui.perfetto.dev';

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  uploadStatus: document.getElementById('upload-status'),
  traceList: document.getElementById('trace-list'),
  emptyState: document.getElementById('empty-state'),
  search: document.getElementById('search'),
  frame: document.getElementById('perfetto-frame'),
  viewerPlaceholder: document.getElementById('viewer-placeholder'),
  viewerToolbar: document.getElementById('viewer-toolbar'),
  viewerTitle: document.getElementById('viewer-title'),
  viewerLoading: document.getElementById('viewer-loading'),
  viewerClose: document.getElementById('viewer-close'),
  viewerFullWindow: document.getElementById('viewer-fullwindow'),
  exitFullWindow: document.getElementById('exit-fullwindow'),
  resizer: document.getElementById('resizer'),
  nameDialog: document.getElementById('name-dialog'),
  nameForm: document.getElementById('name-form'),
  nameInput: document.getElementById('name-input'),
  nameDialogFile: document.getElementById('name-dialog-file'),
};

let traces = [];
let activeTraceId = null;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function refreshTraces() {
  const data = await api('/api/traces');
  traces = data.traces;
  renderTraceList();
}

// ---------------------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------------------

function showStatus(message, isError = false) {
  els.uploadStatus.textContent = message;
  els.uploadStatus.classList.toggle('error', isError);
  els.uploadStatus.hidden = false;
  clearTimeout(showStatus._timer);
  showStatus._timer = setTimeout(() => { els.uploadStatus.hidden = true; }, 5000);
}

function promptForName(fileName) {
  return new Promise((resolve) => {
    els.nameDialogFile.textContent = fileName;
    els.nameInput.value = fileName.replace(/\.(perfetto-trace|pftrace|pb|json|gz|zip|trace)$/i, '');
    els.nameDialog.returnValue = 'cancel';
    els.nameDialog.showModal();
    els.nameInput.focus();
    els.nameInput.select();
    els.nameDialog.addEventListener('close', () => {
      resolve(els.nameDialog.returnValue === 'ok' ? els.nameInput.value.trim() : '');
    }, { once: true });
  });
}

async function uploadFiles(files) {
  for (const file of files) {
    const name = await promptForName(file.name);
    showStatus(`Uploading ${file.name}…`);
    try {
      const params = new URLSearchParams({ filename: file.name, name });
      const trace = await api(`/api/traces?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      showStatus(`Saved "${trace.name}"`);
      await refreshTraces();
      openTrace(trace.id);
    } catch (err) {
      showStatus(`Upload failed: ${err.message}`, true);
    }
  }
}

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') els.fileInput.click();
});
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files.length) uploadFiles([...els.fileInput.files]);
  els.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragover');
  })
);
els.dropzone.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) uploadFiles(files);
});

// Also accept drops anywhere on the page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  if (e.target.closest('#dropzone')) return;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) uploadFiles(files);
});

// ---------------------------------------------------------------------------
// Trace history list
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function renderTraceList() {
  const filter = els.search.value.trim().toLowerCase();
  const visible = traces.filter(
    (t) =>
      !filter ||
      t.name.toLowerCase().includes(filter) ||
      t.originalFileName.toLowerCase().includes(filter)
  );

  els.traceList.innerHTML = '';
  els.emptyState.hidden = traces.length > 0;

  for (const trace of visible) {
    const li = document.createElement('li');
    li.className = 'trace-item' + (trace.id === activeTraceId ? ' active' : '');

    const name = document.createElement('div');
    name.className = 'trace-name';
    name.textContent = trace.name;

    const meta = document.createElement('div');
    meta.className = 'trace-meta';
    meta.textContent = `${trace.originalFileName} · ${formatBytes(trace.sizeBytes)} · ${formatDate(trace.uploadedAt)}`;

    const actions = document.createElement('div');
    actions.className = 'trace-actions';

    const openBtn = button('Open', 'btn btn-small btn-primary', () => openTrace(trace.id));
    const renameBtn = button('Rename', 'btn btn-small', async (e) => {
      e.stopPropagation();
      const name = prompt('New name for this trace:', trace.name);
      if (name === null || !name.trim()) return;
      await api(`/api/traces/${trace.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      await refreshTraces();
      if (trace.id === activeTraceId) els.viewerTitle.textContent = name.trim();
    });
    const downloadBtn = button('Download', 'btn btn-small', (e) => {
      e.stopPropagation();
      window.open(`/api/traces/${trace.id}/file?download=1`, '_blank');
    });
    const deleteBtn = button('Delete', 'btn btn-small btn-danger', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete trace "${trace.name}"? This cannot be undone.`)) return;
      await api(`/api/traces/${trace.id}`, { method: 'DELETE' });
      if (trace.id === activeTraceId) closeViewer();
      await refreshTraces();
    });

    actions.append(openBtn, renameBtn, downloadBtn, deleteBtn);
    li.append(name, meta, actions);
    li.addEventListener('click', () => openTrace(trace.id));
    els.traceList.appendChild(li);
  }
}

function button(label, className, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.className = className;
  btn.addEventListener('click', onClick);
  return btn;
}

els.search.addEventListener('input', renderTraceList);

// ---------------------------------------------------------------------------
// Embedded Perfetto viewer (postMessage deep-linking API)
// https://perfetto.dev/docs/visualization/deep-linking-to-perfetto-ui
// ---------------------------------------------------------------------------

let framePingInterval = null;

function openTrace(id) {
  const trace = traces.find((t) => t.id === id);
  if (!trace) return;
  activeTraceId = id;
  renderTraceList();

  setTraceParam(id);
  els.viewerPlaceholder.hidden = true;
  els.viewerToolbar.hidden = false;
  els.frame.hidden = false;
  els.viewerTitle.textContent = trace.name;
  els.viewerLoading.hidden = false;
  els.viewerLoading.textContent = 'Fetching trace…';

  loadTraceIntoFrame(trace).catch((err) => {
    els.viewerLoading.textContent = `Failed to load trace: ${err.message}`;
  });
}

async function loadTraceIntoFrame(trace) {
  const res = await fetch(`/api/traces/${trace.id}/file`);
  if (!res.ok) throw new Error(`could not fetch trace file (${res.status})`);
  const buffer = await res.arrayBuffer();

  els.viewerLoading.textContent = 'Waiting for Perfetto UI…';

  // (Re)load the Perfetto UI, then handshake: keep PINGing until it PONGs,
  // then post the trace buffer.
  els.frame.src = PERFETTO_ORIGIN + '/';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Perfetto UI did not respond (are you online?)'));
    }, 30000);

    function onMessage(evt) {
      if (evt.origin !== PERFETTO_ORIGIN || evt.data !== 'PONG') return;
      cleanup();
      els.frame.contentWindow.postMessage(
        {
          perfetto: {
            buffer,
            title: trace.name,
            fileName: trace.originalFileName,
          },
        },
        PERFETTO_ORIGIN
      );
      els.viewerLoading.hidden = true;
      resolve();
    }

    function cleanup() {
      clearTimeout(timeout);
      clearInterval(framePingInterval);
      window.removeEventListener('message', onMessage);
    }

    window.addEventListener('message', onMessage);
    clearInterval(framePingInterval);
    framePingInterval = setInterval(() => {
      els.frame.contentWindow?.postMessage('PING', PERFETTO_ORIGIN);
    }, 250);
  });
}

function setTraceParam(id) {
  const url = new URL(window.location);
  if (id) url.searchParams.set('trace', id);
  else url.searchParams.delete('trace');
  history.replaceState(null, '', url);
}

function closeViewer() {
  activeTraceId = null;
  setTraceParam(null);
  setFullWindow(false);
  clearInterval(framePingInterval);
  els.frame.src = 'about:blank';
  els.frame.hidden = true;
  els.viewerToolbar.hidden = true;
  els.viewerPlaceholder.hidden = false;
  renderTraceList();
}

els.viewerClose.addEventListener('click', closeViewer);

// ---------------------------------------------------------------------------
// Resizable columns
// ---------------------------------------------------------------------------

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX_MARGIN = 320; // keep at least this many px for the viewer

// Restore any previously saved width.
const savedWidth = Number(localStorage.getItem('sidebarWidth'));
if (savedWidth) {
  document.documentElement.style.setProperty('--sidebar-width', `${savedWidth}px`);
}

els.resizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  els.resizer.setPointerCapture(e.pointerId);
  els.resizer.classList.add('dragging');
  document.body.classList.add('resizing');

  const onMove = (ev) => {
    const max = window.innerWidth - SIDEBAR_MAX_MARGIN;
    const width = Math.min(Math.max(ev.clientX, SIDEBAR_MIN), Math.max(max, SIDEBAR_MIN));
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  };
  const onUp = () => {
    els.resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const current = getComputedStyle(document.documentElement)
      .getPropertyValue('--sidebar-width').trim();
    if (current) localStorage.setItem('sidebarWidth', parseInt(current, 10));
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

// ---------------------------------------------------------------------------
// Full-window mode (hide all chrome, trace fills the window)
// ---------------------------------------------------------------------------

function setFullWindow(on) {
  document.body.classList.toggle('fullwindow', on);
  els.exitFullWindow.hidden = !on;
}

els.viewerFullWindow.addEventListener('click', () => setFullWindow(true));
els.exitFullWindow.addEventListener('click', () => setFullWindow(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('fullwindow')) {
    setFullWindow(false);
  }
});

// ---------------------------------------------------------------------------

refreshTraces()
  .then(() => {
    const id = new URL(window.location).searchParams.get('trace');
    if (id && traces.some((t) => t.id === id)) openTrace(id);
  })
  .catch((err) => showStatus(`Failed to load traces: ${err.message}`, true));
