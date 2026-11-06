// Sends an approved newsletter (the Email Marketer's newsletter.md) to the
// confirmed subscribers of that opportunity's landing page, never to anyone
// else. Each email carries a personal unsubscribe link and one-click
// unsubscribe headers. Batches use idempotency keys derived from the action id,
// so retrying a failed send does not email anyone twice.
import { slugify } from '../execution.mjs';
import { RESEND_BATCH_LIMIT } from './resend.mjs';
import { parseNewsletter, broadcastEmail } from './templates.mjs';

export const NEWSLETTER_FILE = 'newsletter.md';

export function canBroadcast(action) {
  // Either separator: the artifact path may come from a Windows machine.
  return action?.kind === 'send_email' && typeof action.artifact === 'string' && /[\\/]newsletter\.md$/.test(action.artifact);
}

export function emailLinks(site, signup) {
  const base = site.signupUrl.replace(/\/$/, '');
  return {
    confirmUrl: signup.confirmToken ? `${base}/confirm?t=${signup.confirmToken}` : null,
    unsubscribeUrl: `${base}/unsubscribe?t=${signup.unsubToken}`,
  };
}

export async function sendBroadcast({ store, mailer, action, content, site, maxRecipients = 1000, log = () => {} }) {
  if (!mailer) throw new Error('No email service configured (RESEND_API_KEY)');
  if (!site.signupUrl) throw new Error('Newsletters need AGENTS_SIGNUP_URL so every email has a working unsubscribe link');
  if (!site.postalAddress) throw new Error('Newsletters need AGENTS_POSTAL_ADDRESS: commercial email must include a postal address (CAN-SPAM)');
  const { subject, body } = parseNewsletter(content);
  const page = slugify(action.opportunity ?? '');
  const recipients = store.subscribers(page);
  if (!recipients.length) {
    log(`[Email] ${action.id}: no confirmed subscribers on "${page}" yet; nothing sent`);
    return { status: 'executed', executor: 'email-broadcast', page, sent: 0, recipients: 0, note: 'no confirmed subscribers yet' };
  }
  if (recipients.length > maxRecipients) {
    throw new Error(`${recipients.length} recipients exceeds AGENTS_EMAIL_MAX_RECIPIENTS (${maxRecipients}); raise it deliberately if this is expected`);
  }

  let sent = 0;
  const failures = [];
  for (let i = 0; i < recipients.length; i += RESEND_BATCH_LIMIT) {
    const batch = recipients.slice(i, i + RESEND_BATCH_LIMIT).map((s) => {
      store.ensureUnsubToken(s);
      return broadcastEmail({ to: s.email, subject, body, unsubscribeUrl: emailLinks(site, s).unsubscribeUrl, site });
    });
    try {
      await mailer.sendBatch(batch, { idempotencyKey: `${action.id}-batch-${i / RESEND_BATCH_LIMIT}` });
      sent += batch.length;
    } catch (err) {
      failures.push(err.message);
    }
  }
  log(`[Email] ${action.id}: sent "${subject}" to ${sent}/${recipients.length} subscribers of "${page}"`);
  if (failures.length) {
    throw new Error(`sent ${sent} of ${recipients.length}; ${failures.length} batch(es) failed: ${failures[0]}. Re-approving retries safely within 24h.`);
  }
  return { status: 'executed', executor: 'email-broadcast', page, sent, recipients: recipients.length };
}
