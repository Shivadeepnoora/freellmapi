// Built-in executors used by `execute` and the daemon before falling back to
// the webhook. Each one is {name, canHandle(action), execute(action, content)}.
import { publisherFromConfig } from './github-pages.mjs';
import { publishLandingPage } from './webhook-server.mjs';
import { mailerFromConfig } from '../email/resend.mjs';
import { canBroadcast, sendBroadcast } from '../email/broadcast.mjs';
import { MetricsStore } from '../feedback/metrics.mjs';

// What published pages and emails need to know about the business.
export function siteFromConfig(config) {
  return {
    signupUrl: config.signupUrl || '',
    businessName: config.businessName || '',
    contactEmail: config.contactEmail || '',
    postalAddress: config.postalAddress || '',
  };
}

// Subscribers (emails) live where webhook-server runs. When the company talks
// to a remote server (signup URL + shared secret), newsletters must be sent
// there, through the webhook; otherwise this machine holds them.
export function subscribersAreLocal(config) {
  return !(config.signupUrl && config.webhookSecret && config.metricsSource !== 'local');
}

export function buildExecutors(config, { fetchImpl, log } = {}) {
  const site = siteFromConfig(config);
  const executors = [];
  const publisher = publisherFromConfig(config, { fetchImpl, log });
  if (publisher) {
    executors.push({
      name: 'github-pages',
      canHandle: (action) => publisher.canHandle(action),
      execute: (action, content) => publishLandingPage(publisher, action, content, site),
    });
  }
  const mailer = mailerFromConfig(config, { fetchImpl });
  if (mailer && subscribersAreLocal(config)) {
    const store = new MetricsStore(config.dataDir);
    executors.push({
      name: 'email-broadcast',
      canHandle: canBroadcast,
      execute: (action, content) => sendBroadcast({ store, mailer, action, content, site, maxRecipients: config.emailMaxRecipients, log }),
    });
  }
  return executors;
}
