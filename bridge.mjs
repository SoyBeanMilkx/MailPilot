import { ImapFlow } from "imapflow";
import { activeAgentName } from "./bridge/agents.mjs";
import { envLoad, loadConfig } from "./bridge/config.mjs";
import { acquireLock } from "./bridge/lock.mjs";
import { createMailer } from "./bridge/mailer.mjs";
import { fetchAndProcess } from "./bridge/message.mjs";
import { loadState, saveState, syncMailboxState } from "./bridge/state.mjs";

async function main() {
  const releaseLock = acquireLock();
  process.on("exit", releaseLock);

  envLoad();
  const cfg = loadConfig();
  const state = loadState();
  const mailer = createMailer(cfg);
  const ctx = { cfg, state, mailer };

  console.log(`[bridge] IMAP ${cfg.imap.host}:${cfg.imap.port}`);
  console.log(`[bridge] SMTP ${process.env.SMTP_USER}`);
  console.log(`[bridge] agent: ${activeAgentName(cfg)}`);
  console.log(`[bridge] ${Object.keys(state.threads || {}).length} threads, ${(state.seenIds || []).length} seen`);

  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.tls,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS,
    },
    logger: false,
  });

  client.on("error", (err) => console.error("[bridge] IMAP error:", err.message));

  await client.connect();
  console.log("[bridge] IMAP connected");

  const mailbox = await client.mailboxOpen("INBOX");
  syncMailboxState(state, mailbox);
  console.log(`[bridge] INBOX: ${mailbox.exists} messages, uidNext=${mailbox.uidNext || "unknown"}, lastUid=${state.lastUid}`);

  if (mailbox.exists > 0) {
    const lastUid = Number.parseInt(state.lastUid || 0, 10) || 0;
    if (lastUid > 0 && mailbox.uidNext && lastUid < mailbox.uidNext - 1) {
      await fetchAndProcess(client, ctx, `${lastUid + 1}:*`, { uid: true });
    } else {
      await fetchAndProcess(client, ctx, `${Math.max(1, mailbox.exists - 9)}:${mailbox.exists}`);
    }
  }

  setInterval(async () => {
    try {
      const status = await client.status("INBOX", { messages: true, uidNext: true });
      const uidNext = Number.parseInt(status.uidNext || 0, 10) || 0;
      const nextUid = (Number.parseInt(state.lastUid || 0, 10) || 0) + 1;
      if (uidNext && uidNext > nextUid) {
        console.log(`[bridge] new UID(s): ${nextUid}:* (uidNext=${uidNext}, messages=${status.messages})`);
        const count = await fetchAndProcess(client, ctx, `${nextUid}:*`, { uid: true });
        if (count === 0) {
          state.lastUid = Math.max(Number.parseInt(state.lastUid || 0, 10) || 0, uidNext - 1);
          saveState(state);
        }
      }
    } catch (e) {
      console.error("[bridge] poll error:", e.message);
    }
  }, 3000);

  console.log("[bridge] === Ready (IMAP poll 3s) ===");
  console.log(`[bridge] Email: ${process.env.SMTP_USER}`);
  console.log(`[bridge] ${cfg.commandPrefix} help - command list`);

  async function shutdown() {
    console.log("\n[bridge] shutting down...");
    await client.logout();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[bridge] fatal:", e);
  process.exit(1);
});
