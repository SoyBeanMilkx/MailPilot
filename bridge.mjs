import { ImapFlow } from "imapflow";
import { activeAgentName, stopRunningAgentProcesses } from "./bridge/agents.mjs";
import { envLoad, loadConfig } from "./bridge/config.mjs";
import { acquireLock } from "./bridge/lock.mjs";
import { createMailer } from "./bridge/mailer.mjs";
import { fetchAndProcess } from "./bridge/message.mjs";
import { loadState, saveState, syncMailboxState } from "./bridge/state.mjs";

function createImapClient(cfg) {
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
  return client;
}

function shouldReconnectImap(err) {
  const text = `${err?.code || ""} ${err?.message || ""}`.toLowerCase();
  return (
    text.includes("noconnection") ||
    text.includes("connection not available") ||
    text.includes("socket timeout") ||
    text.includes("unexpected close") ||
    text.includes("closed")
  );
}

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

  let client = null;
  let connecting = null;
  let mailboxInfo = null;
  let pollBusy = false;

  async function closeClient() {
    if (!client) return;
    const oldClient = client;
    client = null;
    try {
      if (oldClient.usable) await oldClient.logout();
      else oldClient.close();
    } catch {
      try { oldClient.close(); } catch {}
    }
  }

  async function connectClient() {
    if (client?.usable) return client;
    if (connecting) return connecting;

    connecting = (async () => {
      await closeClient();
      const nextClient = createImapClient(cfg);
      nextClient.on("close", () => {
        console.error("[bridge] IMAP closed");
        if (client === nextClient) client = null;
      });

      await nextClient.connect();
      client = nextClient;
      console.log("[bridge] IMAP connected");

      mailboxInfo = await nextClient.mailboxOpen("INBOX");
      syncMailboxState(state, mailboxInfo);
      console.log(`[bridge] INBOX: ${mailboxInfo.exists} messages, uidNext=${mailboxInfo.uidNext || "unknown"}, lastUid=${state.lastUid}`);

      return nextClient;
    })().finally(() => {
      connecting = null;
    });

    return connecting;
  }

  await connectClient();
  const mailbox = mailboxInfo;

  if (mailbox.exists > 0) {
    const lastUid = Number.parseInt(state.lastUid || 0, 10) || 0;
    if (lastUid > 0 && mailbox.uidNext && lastUid < mailbox.uidNext - 1) {
      await fetchAndProcess(client, ctx, `${lastUid + 1}:*`, { uid: true });
    } else {
      await fetchAndProcess(client, ctx, `${Math.max(1, mailbox.exists - 9)}:${mailbox.exists}`);
    }
  }

  setInterval(async () => {
    if (pollBusy) return;
    pollBusy = true;

    try {
      const imapClient = await connectClient();
      const status = await imapClient.status("INBOX", { messages: true, uidNext: true });
      const uidNext = Number.parseInt(status.uidNext || 0, 10) || 0;
      const nextUid = (Number.parseInt(state.lastUid || 0, 10) || 0) + 1;
      if (uidNext && uidNext > nextUid) {
        console.log(`[bridge] new UID(s): ${nextUid}:* (uidNext=${uidNext}, messages=${status.messages})`);
        const count = await fetchAndProcess(imapClient, ctx, `${nextUid}:*`, { uid: true });
        if (count === 0) {
          state.lastUid = Math.max(Number.parseInt(state.lastUid || 0, 10) || 0, uidNext - 1);
          saveState(state);
        }
      }
    } catch (e) {
      console.error("[bridge] poll error:", e.message);
      if (shouldReconnectImap(e)) {
        try {
          await closeClient();
          await connectClient();
          console.log("[bridge] IMAP reconnected");
        } catch (reconnectError) {
          console.error("[bridge] IMAP reconnect failed:", reconnectError.message);
        }
      }
    } finally {
      pollBusy = false;
    }
  }, 3000);

  console.log("[bridge] === Ready (IMAP poll 3s) ===");
  console.log(`[bridge] Email: ${process.env.SMTP_USER}`);
  console.log(`[bridge] ${cfg.commandPrefix} help - command list`);

  async function shutdown() {
    console.log("\n[bridge] shutting down...");
    stopRunningAgentProcesses();
    await closeClient();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[bridge] fatal:", e);
  process.exit(1);
});
