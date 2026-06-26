import { activeAgentName, getOrCreateAgentSession, runTaskOnSession } from "./agents.mjs";
import { handleCommand, hasCommand } from "./commands.mjs";
import { parseEmailBody } from "./email-body.mjs";
import { activeJobForThread, createJob, finishJob, formatJob, updateJob } from "./jobs.mjs";
import { replyHeaders, replySubject } from "./mailer.mjs";
import { getThread, markSeen, threadKey, workspaceForThread } from "./state.mjs";

function isAllowed(cfg, fromEmail) {
  return cfg.whitelist.includes(fromEmail.toLowerCase());
}

function shouldSkip(cfg, subject, fromEmail) {
  if (cfg.skipSenders.includes(fromEmail.toLowerCase())) return true;
  const subjectLower = subject.toLowerCase();
  return cfg.skipSubjectKeywords.some((keyword) => subjectLower.includes(keyword.toLowerCase()));
}

function errorText(error) {
  return String(error?.stack || error?.message || error || "unknown error").slice(0, 2000);
}

function finalStatusForResponse(response) {
  if (response.startsWith("[error: agent timed out")) return "timeout";
  if (response.startsWith("[error:") || response.startsWith("[opencode error]")) return "failed";
  return "completed";
}

async function runAgentReplyJob(ctx, job, envelope, subject, body, fromEmail) {
  const { cfg, state, mailer } = ctx;

  try {
    updateJob(job, { status: "queued", phase: "preparing" });
    const { agentName, sessionId, workspaceDir, isNew } = await getOrCreateAgentSession(state, cfg, fromEmail, subject, job);
    if (isNew) {
      console.log("[bridge] new session, waiting for server to settle...");
      updateJob(job, { phase: "session settle wait" });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    const wrapped = `Directly reply to the following email message as yourself:\n\n"""\n${body}\n"""`;
    console.log(`[bridge] cwd: ${workspaceDir}`);
    console.log(`[bridge] -> ${agentName} (session: ${sessionId.slice(-24)})`);
    const start = Date.now();
    const response = await runTaskOnSession(cfg, agentName, sessionId, subject, wrapped, workspaceDir, job);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[bridge] <- ${agentName} (${elapsed}s)`);
    console.log(`[bridge] res: ${response.slice(0, 200)}`);

    updateJob(job, { phase: "sending reply", resultPreview: response });
    const sent = await mailer.sendEmail(fromEmail, replySubject(envelope, subject), response, replyHeaders(envelope));
    console.log(`[bridge] reply ${sent ? "OK" : "FAIL"}`);
    const finalStatus = finalStatusForResponse(response);
    finishJob(job, finalStatus, {
      phase: sent ? "reply sent" : "reply failed",
      resultPreview: response,
      lastError: sent ? (finalStatus === "completed" ? job.lastError : response) : "SMTP reply failed",
    });
  } catch (e) {
    const text = errorText(e);
    console.error("[bridge] job failed:", text.slice(0, 400));
    updateJob(job, { phase: "sending error reply", lastError: text });
    const response = `[bridge error]\n${text}`;
    try {
      await mailer.sendEmail(fromEmail, replySubject(envelope, subject), response, replyHeaders(envelope));
      console.log("[bridge] error reply OK");
    } catch (sendError) {
      console.error("[bridge] error reply FAIL:", sendError.message);
    }
    finishJob(job, "failed", { resultPreview: response, lastError: text });
  }
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

  const key = threadKey(fromEmail, subject);
  const activeJob = activeJobForThread(key);
  if (activeJob) {
    await mailer.sendEmail(
      fromEmail,
      replySubject(envelope, subject),
      [
        "Agent is already working on this email thread.",
        "",
        formatJob(activeJob),
        "",
        `Use ${cfg.commandPrefix} status to refresh the current state.`,
      ].join("\n"),
      replyHeaders(envelope)
    );
    console.log(`[bridge] busy: job ${activeJob.id}`);
    return;
  }

  const existingThread = getThread(state, fromEmail, subject);
  const job = createJob({
    threadKey: key,
    fromEmail,
    subject,
    agentName: activeAgentName(cfg),
    workspaceDir: workspaceForThread(cfg, existingThread),
  });

  console.log(`[bridge] job ${job.id} queued`);
  void runAgentReplyJob(ctx, job, envelope, subject, body, fromEmail);
}

export async function fetchAndProcess(client, ctx, seqOrRange, options = {}) {
  console.log(`[bridge] fetching ${options.uid ? "uid" : "seq"}: ${seqOrRange}`);
  const list = await client.fetch(seqOrRange, { envelope: true, uid: true, source: true }, options);
  const messages = [];

  for await (const msg of list) {
    const uid = msg.uid;
    if (!uid || ctx.state.seenIds.includes(String(uid))) continue;

    const subject = msg.envelope.subject || "(no subject)";
    const source = msg.source?.toString() || "";
    const body = parseEmailBody(source);
    console.log(`[bridge] msg uid=${uid} subject="${subject}" body=${body.length}bytes`);
    messages.push({ uid, envelope: msg.envelope, subject, body });
  }

  for (const msg of messages) {
    await processMessage(ctx, msg.envelope, msg.subject, msg.body);
    markSeen(ctx.state, msg.uid);
  }

  return messages.length;
}
