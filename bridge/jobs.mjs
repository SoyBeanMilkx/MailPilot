const ACTIVE_STATUSES = new Set(["queued", "creating", "running", "stopping"]);
const jobs = new Map();
let nextJobId = 1;

function now() {
  return Date.now();
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function truncate(text, max = 500) {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function shortSession(sessionId) {
  if (!sessionId) return "(pending)";
  return sessionId.length > 24 ? sessionId.slice(-24) : sessionId;
}

function jobTitle(job) {
  return job.subject || job.threadKey || job.id;
}

export function createJob(meta) {
  const timestamp = now();
  const job = {
    id: `${timestamp.toString(36)}-${nextJobId++}`,
    status: "queued",
    phase: "queued",
    threadKey: meta.threadKey,
    fromEmail: meta.fromEmail,
    subject: meta.subject,
    agentName: meta.agentName,
    workspaceDir: meta.workspaceDir,
    sessionId: meta.sessionId || "",
    pid: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    finishedAt: null,
    currentStep: "",
    currentCommand: "",
    lastAssistantMessage: "",
    lastError: "",
    resultPreview: "",
  };
  jobs.set(job.id, job);
  return job;
}

export function updateJob(jobOrId, patch) {
  const job = typeof jobOrId === "string" ? jobs.get(jobOrId) : jobOrId;
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: now() });
  return job;
}

export function finishJob(jobOrId, status, patch = {}) {
  const job = updateJob(jobOrId, {
    ...patch,
    status,
    phase: patch.phase || status,
    finishedAt: now(),
    pid: null,
  });
  pruneJobs();
  return job;
}

export function activeJobForThread(threadKey) {
  for (const job of jobs.values()) {
    if (job.threadKey === threadKey && ACTIVE_STATUSES.has(job.status)) return job;
  }
  return null;
}

export function activeJobs() {
  return [...jobs.values()]
    .filter((job) => ACTIVE_STATUSES.has(job.status))
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function recentJobsForThread(threadKey) {
  return [...jobs.values()]
    .filter((job) => job.threadKey === threadKey)
    .sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt));
}

export function recentJobs(limit = 10) {
  return [...jobs.values()]
    .sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt))
    .slice(0, limit);
}

export function compactJobStatus(job) {
  if (!job) return "(none)";
  const elapsed = formatDuration((job.finishedAt || now()) - job.startedAt);
  return `${job.status} ${job.agentName || "agent"} (${elapsed})`;
}

export function formatJob(job) {
  const elapsed = formatDuration((job.finishedAt || now()) - job.startedAt);
  const idle = formatDuration(now() - job.updatedAt);
  const lines = [
    `status: ${job.status}`,
    `agent: ${job.agentName || "(pending)"}`,
    `thread: ${jobTitle(job)}`,
    `elapsed: ${elapsed}`,
    `last update: ${idle} ago`,
    `cwd: ${job.workspaceDir || "(pending)"}`,
    `session: ${shortSession(job.sessionId)}`,
  ];

  if (job.phase) lines.push(`phase: ${job.phase}`);
  if (job.currentStep) lines.push(`current: ${truncate(job.currentStep, 300)}`);
  if (job.currentCommand) lines.push(`command: ${truncate(job.currentCommand, 500)}`);
  if (job.lastAssistantMessage) lines.push(`last assistant: ${truncate(job.lastAssistantMessage, 500)}`);
  if (job.lastError) lines.push(`last error: ${truncate(job.lastError, 500)}`);
  if (job.resultPreview) lines.push(`result: ${truncate(job.resultPreview, 500)}`);

  return lines.join("\n");
}

export function formatThreadStatus(threadKey) {
  const active = activeJobForThread(threadKey);
  if (active) return formatJob(active);

  const recent = recentJobsForThread(threadKey);
  if (recent.length === 0) return "No job found for this email thread.";
  return `No running job for this email thread.\n\nLast job:\n${formatJob(recent[0])}`;
}

export function formatAllJobStatuses() {
  const running = activeJobs();
  if (running.length > 0) {
    return running
      .map((job, index) => `${index + 1}. ${jobTitle(job)}\n${formatJob(job)}`)
      .join("\n\n");
  }

  const recent = recentJobs(10);
  if (recent.length === 0) return "No jobs have been recorded since bridge started.";
  return `No running jobs.\n\nRecent jobs:\n${recent
    .map((job, index) => `${index + 1}. ${jobTitle(job)} - ${compactJobStatus(job)}`)
    .join("\n")}`;
}

function pruneJobs() {
  const completed = [...jobs.values()]
    .filter((job) => !ACTIVE_STATUSES.has(job.status))
    .sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt));

  for (const job of completed.slice(50)) jobs.delete(job.id);
}
