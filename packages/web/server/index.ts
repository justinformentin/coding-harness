import express from "express";
import cors from "cors";
import { join } from "path";
import { FileRunStore } from "../../../src/run-store.js";
import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// Steering queues keyed by runId — injected messages are drained at iteration boundaries
const steeringQueues = new Map<string, string[]>();

// Active harness runs keyed by runId. A run is registered the moment its
// runId is known (run_init) and removed when its promise settles. The
// AbortController is how the UI stops a run: aborting it tears down the harness
// loop and every sub-`claude` subprocess it spawned (the signal is threaded all
// the way down to runClaudeCode, which kills its child).
type ActiveRun = {
  controller: AbortController;
  running: boolean;
};
const activeRuns = new Map<string, ActiveRun>();

// Best-effort teardown so closing the web server doesn't orphan sub-`claude`
// processes: abort every live run before we go. (claude-code.ts also installs
// its own process-exit backstop, but aborting first lets the loop stop cleanly.)
let teardownInstalled = false;
function installServerTeardown() {
  if (teardownInstalled) return;
  teardownInstalled = true;
  const stopAll = () => {
    for (const run of activeRuns.values()) run.controller.abort();
  };
  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);
  process.once("SIGHUP", stopAll);
}

// Resolve .runs dir relative to cwd (the harness project root)
function getRunsDir(): string {
  return process.env.RUNS_DIR ?? join(process.cwd(), ".runs");
}

// ---- session helpers ----

type SessionSummary = {
  id: string;
  prompt: string;
  iteration: number;
  maxIterations: number;
  doneItems: number;
  totalItems: number;
  startedAt: number;
};

type HarnessMessage = {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
};

async function listSessions(): Promise<SessionSummary[]> {
  const runsDir = getRunsDir();
  let entries: string[];
  try {
    entries = (await readdir(runsDir)).sort().reverse();
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const runId of entries) {
    const dir = join(runsDir, runId);
    let prompt = "(no prompt)";
    try {
      prompt = (await readFile(join(dir, "prompt.md"), "utf-8")).trim();
    } catch {}

    const summary: SessionSummary = {
      id: runId,
      prompt: prompt.split("\n")[0].slice(0, 80),
      iteration: 0,
      maxIterations: 0,
      doneItems: 0,
      totalItems: 0,
      startedAt: 0,
    };

    try {
      const state = JSON.parse(
        await readFile(join(dir, "state.json"), "utf-8"),
      );
      summary.iteration = state.iteration ?? 0;
      summary.maxIterations = state.maxIterations ?? 0;
      summary.totalItems = state.checklist?.length ?? 0;
      summary.doneItems =
        state.checklist?.filter((i: { status: string }) => i.status === "done")
          .length ?? 0;
      summary.startedAt = state.startedAt ?? 0;
    } catch {}

    summaries.push(summary);
  }
  return summaries;
}

async function listChats(sessionId: string): Promise<HarnessMessage[]> {
  const dir = join(getRunsDir(), sessionId);
  try {
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf-8"));
    return (state.messages as HarnessMessage[]) ?? [];
  } catch {
    return [];
  }
}

// The full, ordered transcript the TUI shows, read from the durable event log.
// Far richer than state.messages (which for the claude-code provider is only a
// one-line summary per item): includes assistant text, every tool call, tool
// results, and verifier reports. Each returned object is the raw HarnessEvent
// plus the timestamp it was recorded at.
async function listEvents(
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const store = new FileRunStore(sessionId, getRunsDir());
    return (await store.readEvents()).map((event) => ({
      type: event.type,
      ...event.data,
      timestamp: event.timestamp,
      eventId: event.eventId,
      sequence: event.sequence,
    }));
  } catch {
    return [];
  }
}

// ---- API routes ----

// GET /api/sessions — list all sessions
app.get("/api/sessions", async (_req, res) => {
  try {
    const sessions = await listSessions();
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/sessions/:id/chats — list chats for a session
app.get("/api/sessions/:id/chats", async (req, res) => {
  try {
    const chats = await listChats(req.params.id);
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/sessions/:id/events — full ordered transcript from events.jsonl
app.get("/api/sessions/:id/events", async (req, res) => {
  try {
    const events = await listEvents(req.params.id);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/sessions/:id/chats/:chatId — get a single chat message
app.get("/api/sessions/:id/chats/:chatId", async (req, res) => {
  try {
    const chats = await listChats(req.params.id);
    const index = parseInt(req.params.chatId, 10);
    if (isNaN(index) || index < 0 || index >= chats.length) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    res.json({ chat: chats[index] });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sessions — start a new harness run in the background
app.post("/api/sessions", async (req, res) => {
  try {
    const { prompt } = req.body as { prompt?: string };
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    // Variable-path dynamic imports avoid TypeScript rootDir restrictions while
    // letting tsx resolve the .ts source at runtime.
    const harnessSrc = "../../../src/harness.js";
    const configSrc = "../../../src/config.js";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [harnessMod, configMod] = await Promise.all([
      import(harnessSrc) as Promise<any>,
      import(configSrc) as Promise<any>,
    ]);
    const { runHarness } = harnessMod as { runHarness: Function };
    const { loadConfig } = configMod as { loadConfig: () => Promise<unknown> };

    const config = await loadConfig();

    installServerTeardown();

    // Created up front so we can pass its signal to runHarness; registered under
    // the real runId once run_init fires below.
    const controller = new AbortController();
    let capturedRunId: string | undefined;

    // run_init fires only after runHarness's initial `await saveRunInit(...)`,
    // i.e. asynchronously — so we resolve a promise from the event callback and
    // wait for it rather than reading capturedRunId synchronously.
    let resolveRunId: (id: string) => void;
    const runIdReady = new Promise<string>((resolve) => {
      resolveRunId = resolve;
    });

    const harnessPromise: Promise<unknown> = runHarness(
      prompt,
      config,
      (event: { type: string; runId?: string }) => {
        if (event.type === "run_init" && event.runId) {
          capturedRunId = event.runId;
          steeringQueues.set(capturedRunId, []);
          activeRuns.set(capturedRunId, { controller, running: true });
          resolveRunId(event.runId);
        }
      },
      {
        signal: controller.signal,
        drainSteering: (): string[] => {
          if (!capturedRunId) return [];
          const queued = steeringQueues.get(capturedRunId) ?? [];
          steeringQueues.set(capturedRunId, []);
          return queued;
        },
      },
    );
    // Whatever the outcome (done, stopped, or error), the run is no longer
    // active — clear it from the registry so its status flips to not-running.
    harnessPromise
      .catch((err: Error) => {
        console.error(`[harness ${capturedRunId}] error:`, err.message);
      })
      .finally(() => {
        if (capturedRunId) activeRuns.delete(capturedRunId);
      });

    // Wait for run_init, but don't hang forever if the harness dies before it
    // fires — race against the run settling (capturedRunId stays undefined then).
    const runId = await Promise.race([
      runIdReady,
      harnessPromise.then(
        () => capturedRunId,
        () => capturedRunId,
      ),
    ]);

    if (!runId) {
      res.status(500).json({ error: "harness failed before run_init" });
      return;
    }

    res.status(201).json({ id: runId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/sessions/:id/status — whether the run is still actively executing.
// The UI polls this to decide whether to show a Stop button (running) or a
// Send button (idle). Only runs started by this server process are tracked;
// anything else (completed, or from a prior process) reports not-running.
app.get("/api/sessions/:id/status", (req, res) => {
  const run = activeRuns.get(req.params.id);
  res.json({ running: Boolean(run?.running) });
});

// POST /api/sessions/:id/stop — stop a running harness loop and tear down any
// sub-`claude` subprocesses it spawned. Idempotent: stopping an unknown or
// already-finished run is a no-op that still returns ok.
app.post("/api/sessions/:id/stop", (req, res) => {
  const run = activeRuns.get(req.params.id);
  if (run) {
    run.running = false;
    run.controller.abort();
  }
  res.json({ ok: true, stopped: Boolean(run) });
});

// POST /api/sessions/:id/messages — inject a steering message into a running session
app.post("/api/sessions/:id/messages", (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body as { content?: string };
    if (!content) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    if (!steeringQueues.has(id)) {
      steeringQueues.set(id, []);
    }
    steeringQueues.get(id)!.push(content);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- static client ----

// Serve the built client whenever it exists on disk, regardless of NODE_ENV.
// (In dev, Vite serves the client on its own port and proxies /api here, so the
// build won't exist — that's fine.)
//
// __dirname depends on how the server was launched:
//   - source via bun:  packages/web/server        -> ../dist/client
//   - compiled tsc:    packages/web/dist/server   -> ../../dist/client
// Try both and use whichever build actually exists.
const clientDistCandidates = [
  join(__dirname, "../dist/client"),
  join(__dirname, "../../dist/client"),
];
const clientDist =
  clientDistCandidates.find((p) => existsSync(join(p, "index.html"))) ??
  clientDistCandidates[0];
const clientIndex = join(clientDist, "index.html");
const hasClientBuild = existsSync(clientIndex);

if (hasClientBuild) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(clientIndex);
  });
} else {
  // No build present: don't 404 silently on "/", point the user at the fix.
  app.get("*", (_req, res) => {
    res
      .status(503)
      .type("text/plain")
      .send(
        "Web UI not built yet.\n\n" +
          "Run `npm run build` in packages/web (or `npm run dev` for live reload), then reload.",
      );
  });
}

// ---- start ----

export function startServer(port?: number): Promise<void> {
  return new Promise((resolve) => {
    const p = port ?? parseInt(process.env.PORT ?? "3131", 10);
    app.listen(p, () => {
      console.log(`Harness web server running on http://localhost:${p}`);
      resolve();
    });
  });
}

// Allow direct execution: `node dist/server/index.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}

export default app;
