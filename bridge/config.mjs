import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOL_PATHS = ["/usr/local/bin", "/opt/homebrew/bin"];

export const PROJECT_DIR = path.dirname(MODULE_DIR);
export const STATE_FILE = path.join(PROJECT_DIR, ".opencode-bridge.json");
export const CFG_FILE = path.join(PROJECT_DIR, "bridge.cfg");
export const LOCK_FILE = path.join(PROJECT_DIR, ".bridge.pid");

export function envLoad() {
  const envPath = path.join(PROJECT_DIR, ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
  }

  const currentPath = process.env.PATH || "";
  const pathParts = currentPath.split(":").filter(Boolean);
  process.env.PATH = [...TOOL_PATHS, ...pathParts.filter((part) => !TOOL_PATHS.includes(part))].join(":");
}

export function loadConfig() {
  const cfg = JSON.parse(readFileSync(CFG_FILE, "utf-8"));

  cfg.activeAgent ||= "opencode";
  cfg.agents ||= {};
  cfg.agents.opencode ||= {};
  cfg.agents.codex ||= {};
  cfg.agents.opencode.path ||= "/opt/homebrew/bin/opencode";
  cfg.agents.codex.path ||= "/usr/local/bin/codex";
  cfg.agents.codex.execArgs ||= ["--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
  cfg.agents.codex.resumeArgs ||= ["--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
  cfg.workspaceDir ||= PROJECT_DIR;

  cfg.whitelist ||= [];
  cfg.skipSenders ||= [];
  cfg.skipSubjectKeywords ||= [];
  cfg.commandPrefix ||= "[COMMAND]";
  cfg.maxReplyLength ||= 4000;

  return cfg;
}

export function saveConfig(cfg) {
  writeFileSync(CFG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function expandWorkspacePath(rawPath) {
  if (!rawPath) return "";
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/")) return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}

export function validateWorkspaceDir(rawPath, options = {}) {
  const expanded = expandWorkspacePath(rawPath.trim());
  if (!path.isAbsolute(expanded)) {
    return { ok: false, message: "Workspace path must be absolute, for example: /Users/me/project" };
  }

  try {
    const stat = statSync(expanded);
    if (!stat.isDirectory()) return { ok: false, message: `Workspace is not a directory: ${expanded}` };
  } catch {
    if (options.create) {
      try {
        mkdirSync(expanded, { recursive: true });
        return { ok: true, path: expanded, created: true };
      } catch (e) {
        return { ok: false, message: `Workspace could not be created: ${expanded}\n${e.message}` };
      }
    }
    return { ok: false, message: `Workspace does not exist: ${expanded}` };
  }

  return { ok: true, path: expanded };
}
