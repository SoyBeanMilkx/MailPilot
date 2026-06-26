import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { LOCK_FILE } from "./config.mjs";

let lockFd;

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    const existingPid = Number.parseInt(readFileSync(LOCK_FILE, "utf-8"), 10);
    if (Number.isInteger(existingPid) && existingPid > 0 && processExists(existingPid)) {
      console.error(`[bridge] another bridge is already running (pid ${existingPid})`);
      process.exit(1);
    }
    try { unlinkSync(LOCK_FILE); } catch {}
  }

  try {
    lockFd = openSync(LOCK_FILE, "wx");
    writeFileSync(lockFd, `${process.pid}\n`);
  } catch (e) {
    console.error(`[bridge] lock failed: ${e.message}`);
    process.exit(1);
  }

  return releaseLock;
}

export function releaseLock() {
  if (lockFd === undefined) return;
  try { closeSync(lockFd); } catch {}
  lockFd = undefined;

  try {
    const pid = Number.parseInt(readFileSync(LOCK_FILE, "utf-8"), 10);
    if (pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}
