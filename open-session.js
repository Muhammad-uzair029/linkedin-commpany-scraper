import 'dotenv/config';
import readline from 'node:readline';
import {
  DEFAULT_LINKEDIN_COOKIE,
  DEFAULT_LINKEDIN_URL,
} from './constants.js';
import * as logger from './utils/logger.js';
import {
  authenticate,
  authenticateWithProfile,
  launchLinkedInBrowser,
  preparePage,
} from './scraper.js';

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ url?: string, cookie?: string, profile?: boolean, help?: boolean }} */
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--cookie') out.cookie = argv[++i];
    else if (a === '--profile') out.profile = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printUsage() {
  console.log(`
Opens visible Chrome for LinkedIn.

Recommended (stays logged in — avoids cookie expiry):
  npm run login
  node open-session.js --profile

Cookie mode (often logs you out when LinkedIn detects automation):
  npm run open-session
  node open-session.js [--cookie "li_at=...; JSESSIONID=..."] [--url "..."]

Profile: sign in once in the window; session is saved under .linkedin-profile/
Then scrape with: npm run scrape -- --profile
`);
}

/**
 * @param {import('puppeteer').Browser} browser
 */
function waitUntilDone(browser) {
  const browserClosed = new Promise((resolve) => {
    browser.once('disconnected', () => resolve());
  });

  if (!process.stdin.isTTY) {
    logger.info(
      'Browser is open. Close the Chrome window when you are done (run from your own terminal to use Enter).',
    );
    return browserClosed;
  }

  logger.info('Browser is open. Press Enter here when done, or close Chrome.');

  const enterPressed = new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Press Enter to close the browser… ', () => {
      rl.close();
      resolve();
    });
  });

  return Promise.race([browserClosed, enterPressed]);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const useProfile = args.profile || process.env.LINKEDIN_USE_PROFILE === '1';
  const cookie =
    args.cookie ||
    process.env.LINKEDIN_COOKIE ||
    DEFAULT_LINKEDIN_COOKIE ||
    '';
  const url =
    args.url || process.env.LINKEDIN_URL || DEFAULT_LINKEDIN_URL || '';

  if (!useProfile && !cookie) {
    logger.error('Missing cookie. Use --profile / npm run login, or set LINKEDIN_COOKIE.');
    printUsage();
    process.exit(1);
  }

  if (url && !/^https:\/\/(www\.)?linkedin\.com\//i.test(url)) {
    logger.error('URL must start with https://www.linkedin.com/');
    process.exit(1);
  }

  const targetUrl = url || 'https://www.linkedin.com/feed/';

  logger.info(useProfile ? 'Launching Chrome with saved profile…' : 'Launching Chrome (cookie mode)…', {
    url: targetUrl,
  });

  const browser = await launchLinkedInBrowser(false, { useProfile });
  const page = await browser.newPage();
  await preparePage(page);

  if (useProfile) {
    logger.info(
      'Sign in to LinkedIn in this window if you are not already. Your session is saved for future runs.',
    );
    try {
      await authenticateWithProfile(page);
      if (url && !/\/feed\/?$/i.test(url)) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      logger.info('Page loaded.');
    } catch (err) {
      logger.warn('Not logged in yet — complete sign-in in the browser, then open your People URL.', {
        message: err instanceof Error ? err.message : String(err),
      });
      await page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
    }
  } else {
    await authenticate(page, cookie);
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      logger.info('Page loaded.');
    } catch (err) {
      logger.warn('Navigation failed; window stays open.', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await waitUntilDone(browser);

  if (browser.connected) {
    await browser.close();
  }
  process.exit(0);
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
