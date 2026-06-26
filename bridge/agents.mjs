import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_DIR } from "./config.mjs";
import { getOrCreateThread, getThreadSession, listThreadSessions, saveState, setThreadSession, workspaceForThread } from "./state.mjs";

const DEFAULT_TIMEOUT = 300_000;
const CREATE_TIMEOUT = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export function availableAgents(cfg) {
  return Object.keys(cfg.agents || {}).filter((name) => ["opencode", "codex"].includes(name));
}

export function activeAgentName(cfg) {
  return cfg.activeAgent || "opencode";
}

export function isSupportedAgent(cfg, agentName) {
  return availableAgents(cfg).includes(agentName);
}

function agentConfig(cfg, agentName) {
  const agent = cfg.agents?.[agentName];
  if (!agent) throw new Error(`unknown agent: ${agentName}`);
  return agent;
}

function runFile(label, file, args, timeout = DEFAULT_TIMEOUT, cwd = PROJECT_DIR) {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: MAX_BUFFER,
    }).trim();
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).trim() : "";
    const stdout = e.stdout ? String(e.stdout).trim() : "";
    const message = stderr || stdout || e.message;
    console.error(`[bridge] ${label} failed: ${message.slice(0, 400)}`);
    return null;
  }
}

function parseJsonLines(output) {
  const events = [];
  for (const line of (output || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { events.push(JSON.parse(trimmed)); } catch {}
  }
  return events;
}

function opencodeCreateSession(cfg, title, workspaceDir) {
  const agent = agentConfig(cfg, "opencode");
  const prompt = `${cfg.systemPrompt}\n\nA new conversation started. Wait for instructions. Reply "OK".`;
  const out = runFile("opencode create session", agent.path, [
    "run",
    "--title", title,
    "--dangerously-skip-permissions",
    "--format", "json",
    prompt,
  ], CREATE_TIMEOUT, workspaceDir);

  if (!out) throw new Error(`opencode session creation failed: ${title}`);

  for (const obj of parseJsonLines(out)) {
    if (obj.sessionID) return obj.sessionID;
  }

  throw new Error(`opencode returned no sessionID: ${title}`);
}

function opencodeRunTask(cfg, sessionId, title, task, workspaceDir) {
  const agent = agentConfig(cfg, "opencode");
  const prompt = `${cfg.systemPrompt}\n\n${task}`;
  const out = runFile("opencode run", agent.path, [
    "run",
    "--session", sessionId,
    "--title", title,
    "--dangerously-skip-permissions",
    "--format", "json",
    prompt,
  ], DEFAULT_TIMEOUT, workspaceDir);

  if (!out) return "[error: no response]";

  const texts = [];
  for (const obj of parseJsonLines(out)) {
    if (obj.type === "text" && obj.part?.text) texts.push(obj.part.text);
    else if (obj.type === "error") return `[opencode error] ${obj.error?.data?.message || obj.error?.name || "unknown"}`;
  }

  const response = texts.join("\n").trim();
  return response || out.slice(0, 2000);
}

function withCodexOutputFile(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "remote-opt-codex-"));
  const outputFile = path.join(dir, "last-message.txt");
  try {
    const stdout = fn(outputFile);
    let lastMessage = "";
    try { lastMessage = readFileSync(outputFile, "utf-8").trim(); } catch {}
    return { stdout, lastMessage };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function codexLastMessage(stdout) {
  const events = parseJsonLines(stdout);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
      return event.item.text.trim();
    }
  }
  return "";
}

function codexThreadId(stdout) {
  return parseJsonLines(stdout).find((event) => event.type === "thread.started")?.thread_id;
}

function codexCreateSession(cfg, title, workspaceDir) {
  const agent = agentConfig(cfg, "codex");
  const prompt = `${cfg.systemPrompt}\n\nA new conversation started. Wait for instructions. Reply "OK".`;
  const { stdout } = withCodexOutputFile((outputFile) =>
    runFile("codex create session", agent.path, [
      "exec",
      ...(agent.execArgs || []),
      "--json",
      "-o", outputFile,
      prompt,
    ], CREATE_TIMEOUT, workspaceDir)
  );

  const sessionId = codexThreadId(stdout);
  if (!sessionId) throw new Error(`codex returned no thread_id: ${title}`);
  return sessionId;
}

function codexRunTask(cfg, sessionId, title, task, workspaceDir) {
  const agent = agentConfig(cfg, "codex");
  const prompt = `${cfg.systemPrompt}\n\n${task}`;
  const { stdout, lastMessage } = withCodexOutputFile((outputFile) =>
    runFile("codex resume", agent.path, [
      "exec",
      "resume",
      ...(agent.resumeArgs || []),
      "--json",
      "-o", outputFile,
      sessionId,
      prompt,
    ], DEFAULT_TIMEOUT, workspaceDir)
  );

  return lastMessage || codexLastMessage(stdout) || "[error: no response]";
}

export function createSession(cfg, agentName, title, workspaceDir) {
  console.log(`[bridge] +${agentName} session: ${title}`);
  console.log(`[bridge] workspace: ${workspaceDir}`);
  if (agentName === "opencode") return opencodeCreateSession(cfg, title, workspaceDir);
  if (agentName === "codex") return codexCreateSession(cfg, title, workspaceDir);
  throw new Error(`unknown agent: ${agentName}`);
}

export function runTaskOnSession(cfg, agentName, sessionId, title, task, workspaceDir) {
  if (agentName === "opencode") return opencodeRunTask(cfg, sessionId, title, task, workspaceDir);
  if (agentName === "codex") return codexRunTask(cfg, sessionId, title, task, workspaceDir);
  throw new Error(`unknown agent: ${agentName}`);
}

export function getOrCreateAgentSession(state, cfg, fromEmail, subject) {
  const agentName = activeAgentName(cfg);
  const { thread } = getOrCreateThread(state, fromEmail, subject);
  const workspaceDir = workspaceForThread(cfg, thread);
  const existingSessionId = getThreadSession(thread, agentName);
  if (existingSessionId) return { agentName, sessionId: existingSessionId, workspaceDir, isNew: false };

  const sessionId = createSession(cfg, agentName, subject, workspaceDir);
  setThreadSession(thread, agentName, sessionId);
  saveState(state);
  return { agentName, sessionId, workspaceDir, isNew: true };
}

export function deleteAgentSession(cfg, agentName, sessionId) {
  if (!sessionId) return;

  if (agentName === "opencode") {
    const agent = agentConfig(cfg, "opencode");
    runFile("opencode session delete", agent.path, ["session", "delete", sessionId], 10_000);
    return;
  }

  if (agentName === "codex") {
    const agent = agentConfig(cfg, "codex");
    runFile("codex archive", agent.path, ["archive", sessionId], 20_000);
  }
}

export function deleteThreadSessions(cfg, thread) {
  for (const [agentName, sessionId] of listThreadSessions(thread)) {
    deleteAgentSession(cfg, agentName, sessionId);
  }
}
