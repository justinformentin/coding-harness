import { readdir, readFile } from "fs/promises";
import { join } from "path";

// Resolve .runs dir relative to cwd (the harness project root)
function getRunsDir(): string {
  return process.env.RUNS_DIR ?? join(process.cwd(), ".runs");
}

// ---- Types matching the harness schema ----

export type ChecklistItem = {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "failed";
  acceptanceCriteria: string[];
  evidenceRequired: string[];
  evidenceFound: string[];
  verifierConfig?: {
    requiredCommands?: string[];
    requiredFiles?: string[];
    requiredPatterns?: string[];
    forbiddenPatterns?: string[];
    successIndicators?: string[];
  };
  suggestedCommands?: string[];
  dependencies?: string[];
};

export type Message = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
};

export type Session = {
  id: string;
  prompt: string;
  iteration: number;
  maxIterations: number;
  doneItems: number;
  totalItems: number;
  startedAt: number;
  checklist: ChecklistItem[];
};

export type Chat = Message & {
  index: number;
};

// ---- Core functions ----

export async function listSessions(): Promise<Session[]> {
  const runsDir = getRunsDir();
  let entries: string[];
  try {
    entries = (await readdir(runsDir)).sort().reverse();
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  for (const runId of entries) {
    const dir = join(runsDir, runId);
    let prompt = "(no prompt)";
    try {
      prompt = (await readFile(join(dir, "prompt.md"), "utf-8")).trim();
    } catch {}

    const session: Session = {
      id: runId,
      prompt: prompt.split("\n")[0].slice(0, 80),
      iteration: 0,
      maxIterations: 0,
      doneItems: 0,
      totalItems: 0,
      startedAt: 0,
      checklist: [],
    };

    try {
      const state = JSON.parse(await readFile(join(dir, "state.json"), "utf-8"));
      session.iteration = state.iteration ?? 0;
      session.maxIterations = state.maxIterations ?? 0;
      session.checklist = (state.checklist as ChecklistItem[]) ?? [];
      session.totalItems = session.checklist.length;
      session.doneItems = session.checklist.filter((i) => i.status === "done").length;
      session.startedAt = state.startedAt ?? 0;
    } catch {}

    sessions.push(session);
  }
  return sessions;
}

export async function getSession(id: string): Promise<Session | null> {
  const runsDir = getRunsDir();
  const dir = join(runsDir, id);

  let prompt = "(no prompt)";
  try {
    prompt = (await readFile(join(dir, "prompt.md"), "utf-8")).trim();
  } catch {
    // prompt.md may not exist for all runs
  }

  const session: Session = {
    id,
    prompt: prompt.split("\n")[0].slice(0, 80),
    iteration: 0,
    maxIterations: 0,
    doneItems: 0,
    totalItems: 0,
    startedAt: 0,
    checklist: [],
  };

  try {
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf-8"));
    session.iteration = state.iteration ?? 0;
    session.maxIterations = state.maxIterations ?? 0;
    session.checklist = (state.checklist as ChecklistItem[]) ?? [];
    session.totalItems = session.checklist.length;
    session.doneItems = session.checklist.filter((i) => i.status === "done").length;
    session.startedAt = state.startedAt ?? 0;
  } catch {
    // If there's no state.json at all the run dir likely doesn't exist
    return null;
  }

  return session;
}

export async function listChats(sessionId: string): Promise<Chat[]> {
  const dir = join(getRunsDir(), sessionId);
  try {
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf-8"));
    const messages: Message[] = (state.messages as Message[]) ?? [];
    return messages.map((msg, index) => ({ ...msg, index }));
  } catch {
    return [];
  }
}

export async function getChat(sessionId: string, chatId: number): Promise<Chat | null> {
  const chats = await listChats(sessionId);
  const chat = chats[chatId];
  return chat ?? null;
}
