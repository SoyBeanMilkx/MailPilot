import { getOrCreateAgentSession, runTaskOnSession } from "./agents.mjs";
import { handleCommand, hasCommand } from "./commands.mjs";
import { parseEmailBody } from "./email-body.mjs";
import { replyHeaders, replySubject } from "./mailer.mjs";
import { markSeen } from "./state.mjs";

function isAllowed(cfg, fromEmail) {
  return cfg.whitelist.includes(fromEmail.toLowerCase());
}

function shouldSkip(cfg, subject, fromEmail) {
  if (cfg.skipSenders.includes(fromEmail.toLowerCase())) return true;
  const subjectLower = subject.toLowerCase();
  return cfg.skipSubjectKeywords.some((keyword) => subjectLower.includes(keyword.toLowerCase()));
}

export async function processMessage(ctx, envelope, subject, body) {
  const { cfg, state, mailer } = ctx;
  const fromEmail = envelope.from?.[0]?.address?.toLowerCase();
  const fromName = envelope.from?.[0]?.name || fromEmail;
  if (!fromEmail) return;

  if (shouldSkip(cfg, subject, fromEmail)) return;

  if (!isAllowed(cfg, fromEmail)) {
    console.log(`[bridge] BLOCKED: ${fromEmail} not in whitelist`);
    await mailer.sendEmail(
      fromEmail,
      replySubject(envelope, subject),
      `[auto-reply] Your email ${fromEmail} is not authorized.`,
      replyHeaders(envelope)
    );
    return;
  }

  console.log(`\n[bridge] ${new Date().toLocaleString("zh-CN")}`);
  console.log(`[bridge] from: ${fromName} <${fromEmail}>`);
  console.log(`[bridge] subject: ${subject}`);

  if (hasCommand(cfg, body)) {
    console.log("[bridge] COMMAND detected");
    const result = handleCommand(ctx, body, { fromEmail, subject });
    if (result !== null) {
      await mailer.sendEmail(fromEmail, replySubject(envelope, subject), result, replyHeaders(envelope));
      console.log("[bridge] command handled");
      return;
    }
  }

  const { agentName, sessionId, workspaceDir, isNew } = getOrCreateAgentSession(state, cfg, fromEmail, subject);
  if (isNew) {
    console.log("[bridge] new session, waiting for server to settle...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const wrapped = `Directly reply to the following email message as yourself:\n\n"""\n${body}\n"""`;
  console.log(`[bridge] cwd: ${workspaceDir}`);
  console.log(`[bridge] -> ${agentName} (session: ${sessionId.slice(-24)})`);
  const start = Date.now();
  const response = runTaskOnSession(cfg, agentName, sessionId, subject, wrapped, workspaceDir);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[bridge] <- ${agentName} (${elapsed}s)`);
  console.log(`[bridge] res: ${response.slice(0, 200)}`);

  const sent = await mailer.sendEmail(fromEmail, replySubject(envelope, subject), response, replyHeaders(envelope));
  console.log(`[bridge] reply ${sent ? "OK" : "FAIL"}`);
}

export async function fetchAndProcess(client, ctx, seqOrRange, options = {}) {
  console.log(`[bridge] fetching ${options.uid ? "uid" : "seq"}: ${seqOrRange}`);
  const list = await client.fetch(seqOrRange, { envelope: true, uid: true, source: true }, options);
  let count = 0;

  for await (const msg of list) {
    const uid = msg.uid;
    if (!uid || ctx.state.seenIds.includes(String(uid))) continue;

    const subject = msg.envelope.subject || "(no subject)";
    const source = msg.source?.toString() || "";
    const body = parseEmailBody(source);
    console.log(`[bridge] msg uid=${uid} subject="${subject}" body=${body.length}bytes`);

    await processMessage(ctx, msg.envelope, subject, body);
    markSeen(ctx.state, uid);
    count++;
  }

  return count;
}
