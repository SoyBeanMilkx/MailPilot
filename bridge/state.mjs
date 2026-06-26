import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PROJECT_DIR, STATE_FILE } from "./config.mjs";

export function loadState() {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  return { threads: {}, seenIds: [] };
}

export function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function normalizeSubject(subject) {
  return subject
    .replace(/^(Re|Fw|Fwd|回复|转发)[：:\s]*[\[\(].*?[\]\)]?\s*/gi, "")
    .replace(/^(Re|Fw|Fwd|回复|转发)[：:\s]+/gi, "")
    .trim()
    .toLowerCase();
}

export function threadKey(fromEmail, subject) {
  return `${fromEmail}:${normalizeSubject(subject)}`;
}

export function getThread(state, fromEmail, subject) {
  return state.threads?.[threadKey(fromEmail, subject)];
}

export function getOrCreateThread(state, fromEmail, subject) {
  const key = threadKey(fromEmail, subject);
  if (!state.threads[key]) {
    state.threads[key] = { title: subject, fromEmail, createdAt: Date.now(), sessions: {} };
  }
  normalizeThreadSessions(state.threads[key]);
  return { key, thread: state.threads[key] };
}

export function normalizeThreadSessions(thread) {
  thread.sessions ||= {};

  if (thread.sessionId && !thread.sessions.opencode) {
    thread.sessions.opencode = thread.sessionId;
  }

  return thread.sessions;
}

export function getThreadSession(thread, agentName) {
  return normalizeThreadSessions(thread)[agentName];
}

export function setThreadSession(thread, agentName, sessionId) {
  normalizeThreadSessions(thread)[agentName] = sessionId;
  if (agentName === "opencode") thread.sessionId = sessionId;
}

export function listThreadSessions(thread) {
  return Object.entries(normalizeThreadSessions(thread)).filter(([, sessionId]) => Boolean(sessionId));
}

export function workspaceForThread(cfg, thread) {
  return thread?.workspaceDir || cfg.workspaceDir || PROJECT_DIR;
}

export function maxSeenUid(state) {
  return (state.seenIds || [])
    .map((uid) => Number.parseInt(uid, 10))
    .filter(Number.isFinite)
    .reduce((max, uid) => Math.max(max, uid), 0);
}

export function syncMailboxState(state, mailbox) {
  const uidValidity = mailbox.uidValidity ? String(mailbox.uidValidity) : "";
  if (uidValidity && state.uidValidity && state.uidValidity !== uidValidity) {
    console.log(`[bridge] UIDVALIDITY changed (${state.uidValidity} -> ${uidValidity}); resetting seen state`);
    state.seenIds = [];
    state.lastUid = 0;
  }

  if (uidValidity) state.uidValidity = uidValidity;
  state.seenIds ||= [];
  state.lastUid = Math.max(Number.parseInt(state.lastUid || 0, 10) || 0, maxSeenUid(state));
  saveState(state);
}

export function markSeen(state, uid) {
  const uidStr = String(uid);
  if (!state.seenIds.includes(uidStr)) state.seenIds.push(uidStr);
  if (state.seenIds.length > 2000) state.seenIds = state.seenIds.slice(-2000);

  const uidNum = Number.parseInt(uidStr, 10);
  if (Number.isFinite(uidNum)) state.lastUid = Math.max(Number.parseInt(state.lastUid || 0, 10) || 0, uidNum);
  saveState(state);
}
