import { activeAgentName, availableAgents, deleteThreadSessions, isSupportedAgent } from "./agents.mjs";
import { saveConfig, validateWorkspaceDir } from "./config.mjs";
import { activeJobForThread, compactJobStatus, formatAllJobStatuses, formatThreadStatus } from "./jobs.mjs";
import { getOrCreateThread, getThread, listThreadSessions, saveState, threadKey, workspaceForThread } from "./state.mjs";

export function hasCommand(cfg, body) {
  return body.includes(cfg.commandPrefix);
}

function formatThread(key, thread, index) {
  const sessions = listThreadSessions(thread)
    .map(([agentName, sessionId]) => `${agentName}:${sessionId}`)
    .join(", ") || "(none)";
  const activeJob = activeJobForThread(key);

  return [
    `${index + 1}. [${key}]`,
    `   title: ${thread.title}`,
    `   cwd: ${thread.workspaceDir || "(default)"}`,
    `   sessions: ${sessions}`,
    `   job: ${activeJob ? compactJobStatus(activeJob) : "(none)"}`,
    `   from: ${thread.fromEmail}`,
    `   created: ${new Date(thread.createdAt).toLocaleString("zh-CN")}`,
  ].join("\n");
}

function parseCwdArgs(rest) {
  const parts = rest.split(/\s+/).filter(Boolean);
  const create = parts.includes("--create") || parts.includes("-p");
  const pathParts = parts.filter((part) => part !== "--create" && part !== "-p");
  return { create, targetPath: pathParts.join(" ") };
}

export function handleCommand({ cfg, state }, body, meta = {}) {
  const prefix = cfg.commandPrefix;
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const cmdLine = lines.find((line) => line.startsWith(prefix));
  if (!cmdLine) return null;

  const cmdStr = cmdLine.slice(prefix.length).trim();
  const parts = cmdStr.split(/\s+/);
  const action = parts[0]?.toLowerCase();
  const rest = parts.slice(1).join(" ");

  switch (action) {
    case "help":
      return [
        `${prefix} help                            - show this`,
        `${prefix} list                            - list all sessions`,
        `${prefix} delete <thread-key>             - delete a session`,
        `${prefix} delete-all                      - delete ALL sessions`,
        `${prefix} agent [opencode|codex]          - show or switch active agent`,
        `${prefix} cwd [--create] <absolute-path>  - show or set workspace for a new thread`,
        `${prefix} status [all]                    - show agent working state`,
        `${prefix} config                          - show current config`,
        `${prefix} whitelist add|remove <email>    - manage whitelist`,
      ].join("\n");

    case "list":
    case "ls": {
      const entries = Object.entries(state.threads || {});
      if (entries.length === 0) return "No active sessions.";
      return entries.map(([key, thread], index) => formatThread(key, thread, index)).join("\n\n");
    }

    case "delete":
    case "rm": {
      if (!rest) return `Usage: ${prefix} delete <thread-key>`;
      if (state.threads?.[rest]) {
        const thread = state.threads[rest];
        deleteThreadSessions(cfg, thread);
        delete state.threads[rest];
        saveState(state);
        return `Deleted session "${thread.title}".`;
      }
      return `Thread "${rest}" not found. Use ${prefix} list.`;
    }

    case "delete-all":
    case "clear": {
      const entries = Object.values(state.threads || {});
      for (const thread of entries) deleteThreadSessions(cfg, thread);
      state.threads = {};
      saveState(state);
      return `Deleted ${entries.length} sessions.`;
    }

    case "agent": {
      const nextAgent = parts[1]?.toLowerCase();
      if (!nextAgent || nextAgent === "list") {
        return `agent: ${activeAgentName(cfg)}\navailable: ${availableAgents(cfg).join(", ")}`;
      }

      if (!isSupportedAgent(cfg, nextAgent)) {
        return `Unknown agent: ${nextAgent}. Available: ${availableAgents(cfg).join(", ")}`;
      }

      cfg.activeAgent = nextAgent;
      saveConfig(cfg);
      return `Agent switched to: ${nextAgent}`;
    }

    case "status":
    case "jobs": {
      if (parts[1]?.toLowerCase() === "all") return formatAllJobStatuses();
      if (!meta.fromEmail || !meta.subject) return "Status commands require an email thread.";
      return formatThreadStatus(threadKey(meta.fromEmail, meta.subject));
    }

    case "cwd":
    case "cd": {
      if (!meta.fromEmail || !meta.subject) return "Workspace commands require an email thread.";

      const existingThread = getThread(state, meta.fromEmail, meta.subject);
      if (!rest) {
        return `cwd: ${workspaceForThread(cfg, existingThread)}`;
      }

      if (existingThread) {
        return [
          "Workspace can only be set at the start of a new email thread.",
          "Please send a new email with a new subject and put this command in the first message:",
          `${prefix} cwd ${rest}`,
        ].join("\n");
      }

      const { create, targetPath } = parseCwdArgs(rest);
      if (!targetPath) return `Usage: ${prefix} cwd [--create] <absolute-path>`;

      const validation = validateWorkspaceDir(targetPath, { create });
      if (!validation.ok) return validation.message;

      const { thread } = getOrCreateThread(state, meta.fromEmail, meta.subject);
      thread.workspaceDir = validation.path;
      saveState(state);
      return [
        `${validation.created ? "Workspace created and set" : "Workspace set"} for this email thread: ${validation.path}`,
        "Reply in this thread with your task when ready.",
      ].join("\n");
    }

    case "config":
      return [
        `agent: ${activeAgentName(cfg)}`,
        `default cwd: ${workspaceForThread(cfg)}`,
        `available agents: ${availableAgents(cfg).join(", ")}`,
        `whitelist: ${cfg.whitelist.join(", ")}`,
        `sessions: ${Object.keys(state.threads || {}).length}`,
        `imap: ${cfg.imap.host}:${cfg.imap.port}`,
      ].join("\n");

    case "whitelist": {
      const [sub, rawAddr] = [parts[1], parts[2]];
      const addr = rawAddr?.toLowerCase();
      if (!sub || !addr) return `Usage: ${prefix} whitelist add|remove <email>`;

      if (sub === "add") {
        if (!cfg.whitelist.includes(addr)) {
          cfg.whitelist.push(addr);
          saveConfig(cfg);
          return `Added ${addr} to whitelist.`;
        }
        return `${addr} already in whitelist.`;
      }

      if (sub === "remove" || sub === "rm") {
        cfg.whitelist = cfg.whitelist.filter((email) => email !== addr);
        saveConfig(cfg);
        return `Removed ${addr} from whitelist.`;
      }

      return `Usage: ${prefix} whitelist add|remove <email>`;
    }

    default:
      return `Unknown command: ${action}. Use ${prefix} help.`;
  }
}
