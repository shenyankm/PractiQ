import { withEvidence } from '../../shared/browser-evidence.mjs';

export async function installBrowserFixtures(page) {
  await page.route('**/src/transport.ts*', route => new URL(route.request().url()).searchParams.has('browser-native') ? route.continue() : route.fulfill({
    contentType: 'application/javascript',
    body: 'export { invoke } from "/scripts/fixtures/transport.ts";',
  }));
}

export function withBrowserFixtures(test) {
  return withEvidence(test).extend({ page: async ({ page }, use) => {
    await installBrowserFixtures(page);
    await use(page);
  }});
}
