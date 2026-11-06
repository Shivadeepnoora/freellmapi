// Built-in executors used by `execute` and the daemon before falling back to
// the webhook. Each one is {name, canHandle(action), execute(action, content)}.
import { publisherFromConfig } from './github-pages.mjs';
import { publishLandingPage } from './webhook-server.mjs';

export function buildExecutors(config, { fetchImpl, log } = {}) {
  const publisher = publisherFromConfig(config, { fetchImpl, log });
  if (!publisher) return [];
  return [{
    name: 'github-pages',
    canHandle: (action) => publisher.canHandle(action),
    execute: (action, content) => publishLandingPage(publisher, action, content),
  }];
}
