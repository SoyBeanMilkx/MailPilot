function extractText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n").trim();
}

function decodePart(body, cte) {
  const enc = cte.toLowerCase().trim();
  if (enc === "base64") {
    try { return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8"); } catch { return body; }
  }
  if (enc === "quoted-printable") {
    return body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

export function parseEmailBody(source) {
  const headerEnd = source.search(/\r?\n\r?\n/);
  if (headerEnd === -1) return source;
  const raw = source.slice(headerEnd).replace(/^\r?\n/, "");

  const ctMatch = source.match(/^Content-Type:\s*(.+)$/im);
  const ct = ctMatch ? ctMatch[1].toLowerCase() : "";
  const cteMatch = source.match(/^Content-Transfer-Encoding:\s*(.+)$/im);
  const cte = cteMatch ? cteMatch[1] : "";

  const bm = ct.match(/boundary="?([^";\s]+)"?/);
  if (bm) {
    const boundary = bm[1];
    const parts = raw.split("--" + boundary);

    for (const part of parts) {
      const pc = (part.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";
      const pe = (part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1] || "";
      if (pc.includes("text/plain")) {
        const body = part.replace(/^[\s\S]*?\r?\n\r?\n/, "").trim();
        return decodePart(body, pe);
      }
    }

    for (const part of parts) {
      const pc = (part.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";
      const pe = (part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1] || "";
      if (pc.includes("text/")) {
        const body = part.replace(/^[\s\S]*?\r?\n\r?\n/, "").trim();
        const decoded = decodePart(body, pe);
        return pc.includes("html") ? extractText(decoded) : decoded;
      }
    }
  }

  const decoded = decodePart(raw, cte);
  return ct.includes("text/html") ? extractText(decoded) : decoded;
}
