# @harness/web

The web UI package for coding-harness. Provides a React chat application served by an Express server, letting you browse harness sessions and their chat histories in the browser.

## What it does

- Serves a React SPA that lists all harness sessions (runs) stored in `.runs/`
- Shows the chat history (messages) for each session
- Exposes a REST API consumed by the React client
- Can be launched from the main harness CLI via `--web`, or run standalone

## Integration with the main harness (`--web` flag)

From the harness project root:

```sh
harness --web
```

This starts the Express server on port 3131 and opens `http://localhost:3131` in your default browser. The server reads session data from `.runs/` in the current working directory.

## Running standalone

### Development mode (hot reload)

```sh
cd packages/web
npm install
npm run dev
```

This starts two processes concurrently:
- `tsx watch server/index.ts` — Express API server (port 3131 by default)
- `vite client` — Vite dev server for the React client (typically port 5173)

### Production build

```sh
npm run build
```

Outputs:
- `dist/client/` — compiled React SPA
- `dist/server/` — compiled Express server (ESM JS)

### Start production server

```sh
npm start
# or
node dist/server/index.js
```

## Port configuration

The server defaults to port **3131**. Override with the `PORT` environment variable:

```sh
PORT=8080 node dist/server/index.js
```

The `RUNS_DIR` environment variable controls where session data is read from (defaults to `<cwd>/.runs`):

```sh
RUNS_DIR=/path/to/runs node dist/server/index.js
```

## API endpoints

All endpoints return JSON.

### `GET /api/sessions`

List all harness sessions.

**Response:**
```json
{
  "sessions": [
    {
      "id": "run-20240101-abc123",
      "prompt": "First line of the prompt",
      "iteration": 3,
      "maxIterations": 10,
      "doneItems": 2,
      "totalItems": 5,
      "startedAt": 1704067200000
    }
  ]
}
```

### `GET /api/sessions/:id/chats`

List all chat messages for a session.

**Response:**
```json
{
  "chats": [
    {
      "index": 0,
      "role": "user",
      "content": "message text"
    },
    {
      "index": 1,
      "role": "assistant",
      "content": "response text",
      "toolCalls": [
        { "id": "call_abc", "name": "Read", "arguments": "{\"file_path\":\"/foo\"}" }
      ]
    }
  ]
}
```

### `GET /api/sessions/:id/chats/:chatId`

Get a single chat message by zero-based index.

**Response:**
```json
{
  "chat": {
    "index": 1,
    "role": "assistant",
    "content": "response text"
  }
}
```

Returns `404` if the index is out of range.

## Project structure

```
packages/web/
├── client/          # React SPA source
├── server/
│   ├── index.ts     # Express app + startServer() export
│   └── sessions.ts  # Session/chat data helpers
├── dist/            # Build output (git-ignored)
│   ├── client/
│   └── server/
├── vite.config.ts
├── tsconfig.json
└── package.json
```
