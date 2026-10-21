import { writeFile } from 'node:fs/promises';

// Capture the rendered theme and viewport rather than guessing from a test title.
export function withEvidence(test) {
  return test.extend({ page: async ({page}, use, testInfo) => {
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.dataset.uiuxEvidence = 'true';
      const style = document.createElement('style');
      style.textContent = '.preview-controls { display: none !important; }';
      document.head.append(style);
    }));
    const metadata = () => page.evaluate(() => ({
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      locale: document.documentElement.lang || navigator.language,
    }));
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async (options = {}) => {
      if (options.fullPage) await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
      const result = await screenshot({...options, animations:'disabled'});
      if (options.path) await writeFile(`${options.path}.json`, JSON.stringify({...await metadata(), title:testInfo.title}, null, 2));
      return result;
    };
    await use(page);
    await writeFile(testInfo.outputPath('capture-context.json'), JSON.stringify({...await metadata(), title:testInfo.title, status:testInfo.status}, null, 2));
  }});
}
