import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_DIR } from "./config.mjs";
import { updateJob } from "./jobs.mjs";
import { getOrCreateThread, getThreadSession, listThreadSessions, saveState, setThreadSession, workspaceForThread } from "./state.mjs";

const DEFAULT_TIMEOUT = 1_800_000;
const CREATE_TIMEOUT = 120_000;
const MAX_BUFFER = 50 * 1024 * 1024;
const runningChildren = new Set();

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

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function compactError(message) {
  const text = String(message || "").trim();
  return text ? text.slice(0, 500) : "agent failed before producing a final reply";
}

function taskTimeout(cfg) {
  return positiveInt(cfg.agentTimeoutMs, DEFAULT_TIMEOUT);
}

function createTimeout(cfg) {
  return positiveInt(cfg.agentCreateTimeoutMs, CREATE_TIMEOUT);
}

function appendLimited(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next;
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function updateJobFromEvent(job, agentName, event) {
  if (!job || !event || typeof event !== "object") return;

  if (agentName === "codex") {
    const patch = {};
    if (event.type) {
      patch.currentStep = event.type;
      if (event.type === "thread.started" && event.thread_id) patch.sessionId = event.thread_id;
      if (event.type === "turn.started") patch.phase = "running";
      if (event.type === "turn.completed") patch.phase = "completed";
      if (event.type === "error") {
        patch.status = "failed";
        patch.lastError = event.message || event.error || "codex error";
      }
    }

    const item = event.item;
    if (item) {
      patch.currentStep = `${event.type || "item"}: ${item.type || item.id || "item"}`;
      if (item.type === "command_execution") {
        patch.phase = item.status ? `command ${item.status}` : "running command";
        patch.currentCommand = item.command || patch.currentCommand;
        if (item.exit_code !== undefined && item.exit_code !== null) {
          patch.currentStep = `command_execution exit ${item.exit_code}`;
        }
      }
      if (item.type === "agent_message" && item.text) {
        patch.phase = "assistant message";
        patch.lastAssistantMessage = item.text;
      }
    }

    updateJob(job, patch);
    return;
  }

  if (agentName === "opencode") {
    const patch = {};
    if (event.sessionID) patch.sessionId = event.sessionID;
    if (event.type) patch.currentStep = event.type;
    if (event.type === "text" && event.part?.text) {
      patch.phase = "assistant message";
      patch.lastAssistantMessage = event.part.text;
    }
    if (event.type === "error") {
      patch.status = "failed";
      patch.lastError = event.error?.data?.message || event.error?.name || "opencode error";
    }
    updateJob(job, patch);
  }
}

function runProcess(label, file, args, timeout = DEFAULT_TIMEOUT, cwd = PROJECT_DIR, agentName = "", job = null) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutPending = "";
    let spawnError = null;
    let timedOut = false;
    let killTimer = null;

    const child = spawn(file, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    runningChildren.add(child);
    updateJob(job, { pid: child.pid || null });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      updateJob(job, {
        status: "stopping",
        phase: "timeout",
        lastError: `agent timed out after ${formatDuration(timeout)}`,
      });
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeout);

    function handleStdout(text) {
      stdout = appendLimited(stdout, text);
      stdoutPending += text;
      const lines = stdoutPending.split(/\r?\n/);
      stdoutPending = lines.pop() || "";
      for (const line of lines) {
        const event = parseJsonLine(line);
        if (event) updateJobFromEvent(job, agentName, event);
      }
    }

    child.stdout.on("data", (chunk) => handleStdout(chunk.toString("utf-8")));
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf-8"));
    });

    child.on("error", (err) => {
      spawnError = err;
      updateJob(job, { status: "failed", phase: "spawn failed", lastError: err.message });
    });

    child.on("close", (exitCode, signal) => {
      runningChildren.delete(child);
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);

      if (stdoutPending.trim()) {
        const event = parseJsonLine(stdoutPending);
        if (event) updateJobFromEvent(job, agentName, event);
      }

      const ok = !spawnError && !timedOut && exitCode === 0;
      const message = spawnError?.message ||
        (timedOut ? `agent timed out after ${formatDuration(timeout)}` : "") ||
        stderr.trim() ||
        (exitCode === 0 ? "" : `process exited with code ${exitCode ?? "unknown"}${signal ? ` signal ${signal}` : ""}`);

      if (!ok) {
        const details = stderr.trim() || stdout.trim() || message;
        const status = timedOut ? `timed out after ${formatDuration(timeout)}` : "failed";
        console.error(`[bridge] ${label} ${status}: ${details.slice(0, 400)}`);
      }

      updateJob(job, { pid: null });
      resolve({
        ok,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        message,
        exitCode,
        signal,
      });
    });
  });
}

export function stopRunningAgentProcesses() {
  for (const child of runningChildren) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

function runFile(label, file, args, timeout = DEFAULT_TIMEOUT, cwd = PROJECT_DIR) {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: MAX_BUFFER,
    }).trim();
    return { ok: true, stdout, stderr: "", timedOut: false, message: "" };
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).trim() : "";
    const stdout = e.stdout ? String(e.stdout).trim() : "";
    const details = stderr || stdout || e.message;
    const message = stderr || e.message || "agent process exited before producing a final reply";
    const timedOut = e.code === "ETIMEDOUT" || e.signal === "SIGTERM" || /timed out/i.test(e.message || "");
    const status = timedOut ? `timed out after ${formatDuration(timeout)}` : "failed";
    console.error(`[bridge] ${label} ${status}: ${details.slice(0, 400)}`);
    return { ok: false, stdout, stderr, timedOut, message };
  }
}

function parseJsonLines(output) {
  const events = [];
  for (const line of (output || "").split("\n")) {
    const event = parseJsonLine(line);
    if (event) events.push(event);
  }
  return events;
}

async function opencodeCreateSession(cfg, title, workspaceDir, job = null) {
  const agent = agentConfig(cfg, "opencode");
  const prompt = `${cfg.systemPrompt}\n\nA new conversation started. Wait for instructions. Reply "OK".`;
  updateJob(job, { status: "creating", phase: "creating session" });
  const result = await runProcess("opencode create session", agent.path, [
    "run",
    "--title", title,
    "--dangerously-skip-permissions",
    "--format", "json",
    prompt,
  ], createTimeout(cfg), workspaceDir, "opencode", job);

  if (!result.stdout) throw new Error(`opencode session creation failed: ${title}`);

  for (const obj of parseJsonLines(result.stdout)) {
    if (obj.sessionID) return obj.sessionID;
  }

  throw new Error(`opencode returned no sessionID: ${title}`);
}

async function opencodeRunTask(cfg, sessionId, title, task, workspaceDir, job = null) {
  const agent = agentConfig(cfg, "opencode");
  const prompt = `${cfg.systemPrompt}\n\n${task}`;
  const timeout = taskTimeout(cfg);
  updateJob(job, {
    status: "running",
    phase: "running",
    sessionId,
    currentStep: "starting task",
    currentCommand: "",
  });
  const result = await runProcess("opencode run", agent.path, [
    "run",
    "--session", sessionId,
    "--title", title,
    "--dangerously-skip-permissions",
    "--format", "json",
    prompt,
  ], timeout, workspaceDir, "opencode", job);

  if (!result.stdout) {
    if (result.timedOut) return `[error: agent timed out after ${formatDuration(timeout)} before producing a final reply]`;
    return `[error: ${result.message || "no response"}]`;
  }

  const texts = [];
  for (const obj of parseJsonLines(result.stdout)) {
    if (obj.type === "text" && obj.part?.text) texts.push(obj.part.text);
    else if (obj.type === "error") return `[opencode error] ${obj.error?.data?.message || obj.error?.name || "unknown"}`;
  }

  const response = texts.join("\n").trim();
  if (result.timedOut) return `[error: agent timed out after ${formatDuration(timeout)} before producing a final reply]`;
  if (!result.ok) {
    const note = `[error: ${compactError(result.message)}]`;
    return response ? `${note}\n\nLast assistant message before failure:\n${response}` : note;
  }
  if (response) return response;
  return result.stdout.slice(0, 2000);
}

async function withCodexOutputFile(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "remote-opt-codex-"));
  const outputFile = path.join(dir, "last-message.txt");
  try {
    const result = await fn(outputFile);
    let lastMessage = "";
    try { lastMessage = readFileSync(outputFile, "utf-8").trim(); } catch {}
    return { ...result, lastMessage };
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

async function codexCreateSession(cfg, title, workspaceDir, job = null) {
  const agent = agentConfig(cfg, "codex");
  const prompt = `${cfg.systemPrompt}\n\nA new conversation started. Wait for instructions. Reply "OK".`;
  updateJob(job, { status: "creating", phase: "creating session" });
  const { stdout } = await withCodexOutputFile((outputFile) =>
    runProcess("codex create session", agent.path, [
      "exec",
      ...(agent.execArgs || []),
      "--json",
      "-o", outputFile,
      prompt,
    ], createTimeout(cfg), workspaceDir, "codex", job)
  );

  const sessionId = codexThreadId(stdout);
  if (!sessionId) throw new Error(`codex returned no thread_id: ${title}`);
  return sessionId;
}

async function codexRunTask(cfg, sessionId, title, task, workspaceDir, job = null) {
  const agent = agentConfig(cfg, "codex");
  const prompt = `${cfg.systemPrompt}\n\n${task}`;
  const timeout = taskTimeout(cfg);
  updateJob(job, {
    status: "running",
    phase: "running",
    sessionId,
    currentStep: "starting task",
    currentCommand: "",
  });
  const { stdout, lastMessage, ok, timedOut, message } = await withCodexOutputFile((outputFile) =>
    runProcess("codex resume", agent.path, [
      "exec",
      "resume",
      ...(agent.resumeArgs || []),
      "--json",
      "-o", outputFile,
      sessionId,
      prompt,
    ], timeout, workspaceDir, "codex", job)
  );

  if (lastMessage) return lastMessage;
  if (timedOut) {
    const partial = codexLastMessage(stdout);
    const note = `[error: agent timed out after ${formatDuration(timeout)} before producing a final reply]`;
    return partial ? `${note}\n\nLast assistant message before timeout:\n${partial}` : note;
  }
  if (!ok) {
    const partial = codexLastMessage(stdout);
    const note = `[error: ${compactError(message)}]`;
    return partial ? `${note}\n\nLast assistant message before failure:\n${partial}` : note;
  }

  return codexLastMessage(stdout) || "[error: no response]";
}

export async function createSession(cfg, agentName, title, workspaceDir, job = null) {
  console.log(`[bridge] +${agentName} session: ${title}`);
  console.log(`[bridge] workspace: ${workspaceDir}`);
  if (agentName === "opencode") return opencodeCreateSession(cfg, title, workspaceDir, job);
  if (agentName === "codex") return codexCreateSession(cfg, title, workspaceDir, job);
  throw new Error(`unknown agent: ${agentName}`);
}

export function runTaskOnSession(cfg, agentName, sessionId, title, task, workspaceDir, job = null) {
  if (agentName === "opencode") return opencodeRunTask(cfg, sessionId, title, task, workspaceDir, job);
  if (agentName === "codex") return codexRunTask(cfg, sessionId, title, task, workspaceDir, job);
  throw new Error(`unknown agent: ${agentName}`);
}

export async function getOrCreateAgentSession(state, cfg, fromEmail, subject, job = null) {
  const agentName = activeAgentName(cfg);
  const { thread } = getOrCreateThread(state, fromEmail, subject);
  const workspaceDir = workspaceForThread(cfg, thread);
  const existingSessionId = getThreadSession(thread, agentName);
  if (existingSessionId) {
    updateJob(job, { agentName, sessionId: existingSessionId, workspaceDir });
    return { agentName, sessionId: existingSessionId, workspaceDir, isNew: false };
  }

  const sessionId = await createSession(cfg, agentName, subject, workspaceDir, job);
  setThreadSession(thread, agentName, sessionId);
  saveState(state);
  updateJob(job, { agentName, sessionId, workspaceDir });
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
