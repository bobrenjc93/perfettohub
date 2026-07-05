# ⚡ PerfettoHub

A local hub for storing, naming, and viewing [Perfetto](https://perfetto.dev) traces.
Drag and drop trace files, give them names, keep a searchable history, and open any
trace in an embedded Perfetto UI viewer — all from a single local web server with
zero dependencies.

## Features

- **Drag & drop uploads** — drop `.perfetto-trace`, `.pftrace`, `.pb`, `.json`, `.gz`
  (or any other Perfetto-compatible) files anywhere on the page.
- **Named traces** — you're prompted to name each trace on upload; rename any time.
- **Persistent history** — traces and metadata are stored on disk under `data/`, so
  your history survives restarts. Filter the list with the search box.
- **Embedded viewer** — traces open inside an embedded [ui.perfetto.dev](https://ui.perfetto.dev)
  iframe using Perfetto's official postMessage deep-linking API. The trace bytes are
  posted directly into the iframe; they are never uploaded to any remote server.
- **Download & delete** — pull the original trace file back out, or remove old traces.

## Getting started

Requires Node.js ≥ 18. No `npm install` needed.

```sh
node server.js
# → PerfettoHub running at http://localhost:3000
```

Set `PORT` to use a different port: `PORT=8080 node server.js`.

> **Note:** the embedded viewer loads the Perfetto UI from `ui.perfetto.dev`, so an
> internet connection is needed to view traces. Your trace data itself stays local.

## API

| Method   | Route                        | Description                              |
| -------- | ---------------------------- | ---------------------------------------- |
| `GET`    | `/api/traces`                | List all traces (newest first)           |
| `POST`   | `/api/traces?filename=&name=`| Upload a trace (raw bytes as body)       |
| `GET`    | `/api/traces/:id`            | Get one trace's metadata                 |
| `PATCH`  | `/api/traces/:id`            | Rename a trace (`{"name": "..."}`)       |
| `DELETE` | `/api/traces/:id`            | Delete a trace and its file              |
| `GET`    | `/api/traces/:id/file`       | Fetch the raw trace bytes (`?download=1` for attachment) |

## Storage layout

```
data/
├── traces.json     # metadata: id, name, original filename, size, upload time
└── traces/         # the raw trace files
```
