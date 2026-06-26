import nodemailer from "nodemailer";

export function replySubject(envelope, fallbackSubject) {
  const original = (envelope?.subject || fallbackSubject || "").trim();
  if (!original || original === "(no subject)") return "";
  return /^(Re|回复)[：:\s]/i.test(original) ? original : `Re: ${original}`;
}

export function replyHeaders(envelope) {
  if (!envelope?.messageId) return {};

  const references = [envelope.inReplyTo, envelope.messageId].filter(Boolean);
  return {
    inReplyTo: envelope.messageId,
    references,
  };
}

export function createMailer(cfg) {
  const transporter = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return {
    async sendEmail(to, subject, body, options = {}) {
      const maxLen = cfg.maxReplyLength || 4000;
      const text = body.length > maxLen ? `${body.slice(0, maxLen - 20)}\n\n[...truncated]` : body;
      const senderName = cfg.senderName || "Bridge";

      try {
        await transporter.sendMail({
          from: `"${senderName.replace(/"/g, "'")}" <${process.env.SMTP_USER}>`,
          to,
          subject,
          text,
          ...options,
        });
        return true;
      } catch (e) {
        console.error(`[bridge] SMTP send failed: ${e.message}`);
        return false;
      }
    },
  };
}
