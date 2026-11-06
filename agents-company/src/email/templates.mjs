// Email content. Confirmation and welcome emails are fixed templates (they go
// out automatically, so no AI-written text is sent without a human seeing it).
// Newsletters are AI drafts that a human approved; this file wraps them with
// the legally required parts: who sent it, a postal address, and a working
// unsubscribe link plus RFC 8058 one-click unsubscribe headers.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const shell = (body) => `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6">
<div style="max-width:560px;margin:0 auto;background:#fff;padding:28px;border-radius:8px;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#222">
${body}
</div></body></html>`;

function footer(site, unsubscribeUrl) {
  const who = site.businessName || 'the sender';
  const lines = [
    `You're getting this because you signed up on our page.`,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : '',
    [who, site.postalAddress].filter(Boolean).join(', '),
  ].filter(Boolean);
  const html = `<hr style="border:0;border-top:1px solid #eee;margin:28px 0 12px">
<p style="font-size:13px;color:#777;margin:0">You're getting this because you signed up on our page.
${unsubscribeUrl ? `<a href="${esc(unsubscribeUrl)}" style="color:#777">Unsubscribe</a>.` : ''}<br>${esc([who, site.postalAddress].filter(Boolean).join(', '))}</p>`;
  return { text: `\n\n--\n${lines.join('\n')}`, html };
}

export function unsubscribeHeaders(unsubscribeUrl) {
  return { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

export function confirmationEmail({ to, opportunity, confirmUrl, site }) {
  const name = opportunity || 'our project';
  const subject = `Please confirm your signup for ${name}`;
  const text = `Hi,\n\nPlease confirm you want updates about ${name}:\n${confirmUrl}\n\nIf you didn't sign up, ignore this email and you won't hear from us again.\n\n${site.businessName || ''}`.trim();
  const html = shell(`<p>Hi,</p><p>Please confirm you want updates about <strong>${esc(name)}</strong>.</p>
<p><a href="${esc(confirmUrl)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Confirm my signup</a></p>
<p style="color:#666">If you didn't sign up, ignore this email and you won't hear from us again.</p>
<p>${esc(site.businessName || '')}</p>`);
  return { to, subject, text, html };
}

export function welcomeEmail({ to, opportunity, unsubscribeUrl, site }) {
  const name = opportunity || 'our project';
  const subject = `You're on the list for ${name}`;
  const f = footer(site, unsubscribeUrl);
  const text = `Hi,\n\nThanks for signing up. You're on the list for ${name}. We'll email you when there's real news, such as early access, launch dates or what we're building, and nothing else.\n\nYou can reply to this email any time.\n\n${site.businessName || ''}${f.text}`;
  const html = shell(`<p>Hi,</p><p>Thanks for signing up. You're on the list for <strong>${esc(name)}</strong>.</p>
<p>We'll email you when there's real news, such as early access, launch dates or what we're building, and nothing else.</p>
<p>You can reply to this email any time.</p><p>${esc(site.businessName || '')}</p>${f.html}`);
  return { to, subject, text, html, headers: unsubscribeUrl ? unsubscribeHeaders(unsubscribeUrl) : undefined };
}

// newsletter.md format: first line "Subject: …", blank line, Markdown body.
export function parseNewsletter(markdown) {
  const src = String(markdown ?? '').replace(/\r\n/g, '\n').trim();
  const m = /^subject:[ \t]*(.*)(?:\n+([\s\S]*))?$/i.exec(src);
  if (!m) throw new Error('newsletter.md must start with a "Subject: …" line');
  const subject = m[1].trim().slice(0, 200);
  const body = (m[2] ?? '').trim();
  if (!subject || !body) throw new Error('newsletter.md needs a subject and a body');
  return { subject, body };
}

export function broadcastEmail({ to, subject, body, unsubscribeUrl, site }) {
  const f = footer(site, unsubscribeUrl);
  return {
    to,
    subject,
    text: `${markdownToText(body)}${f.text}`,
    html: shell(`${markdownToHtml(body)}${f.html}`),
    headers: unsubscribeHeaders(unsubscribeUrl),
  };
}

// Small, safe Markdown subset: headings, paragraphs, bullet lists, **bold**,
// [links](https://…). Everything is escaped first; only http(s)/mailto links survive.
export function markdownToHtml(md) {
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
  return String(md).trim().split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    const h = /^(#{1,3})\s+(.*)$/.exec(block);
    if (h && lines.length === 1) return `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

export function markdownToText(md) {
  return String(md).trim()
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,3}\s+/gm, '');
}

// Small HTML pages shown when someone clicks a link in an email. Actions need a
// button press (POST), so link scanners that pre-open URLs can't confirm or
// unsubscribe anyone by accident.
export function actionPage({ title, message, button, action }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#222}button{font:inherit;background:#111;color:#fff;border:0;padding:10px 18px;border-radius:6px;cursor:pointer}</style>
</head><body><h1>${esc(title)}</h1><p>${esc(message)}</p>
${button ? `<form method="post" action="${esc(action)}"><button type="submit">${esc(button)}</button></form>` : ''}
</body></html>`;
}
