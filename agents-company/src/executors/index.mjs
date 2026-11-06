// Built-in executors used by `execute` and the daemon before falling back to
// the webhook. Each one is {name, canHandle(action), execute(action, content)}.
import { publisherFromConfig } from './github-pages.mjs';
import { publishLandingPage } from './webhook-server.mjs';

// What a published page needs to know about the business and where signups go.
export function siteFromConfig(config) {
  return { signupUrl: config.signupUrl || '', businessName: config.businessName || '', contactEmail: config.contactEmail || '' };
}

export function buildExecutors(config, { fetchImpl, log } = {}) {
  const publisher = publisherFromConfig(config, { fetchImpl, log });
  if (!publisher) return [];
  const site = siteFromConfig(config);
  return [{
    name: 'github-pages',
    canHandle: (action) => publisher.canHandle(action),
    execute: (action, content) => publishLandingPage(publisher, action, content, site),
  }];
}
