import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { config, profileDir } from './config.js';
import * as logger from './utils/logger.js';
import { createIncrementalWriter } from './utils/fileHandler.js';

export class SessionWallError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SessionWallError';
  }
}

export class NavigationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NavigationError';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

const HTTP_ONLY_COOKIE_NAMES = new Set([
  'li_at',
  'JSESSIONID',
  'bcookie',
  'bscookie',
  'li_rm',
  'liap',
  'lidc',
  'fptctx2',
]);

/**
 * Prefer bundled Chrome-for-Testing; fall back to a system Chrome install.
 * @param {boolean} headless
 * @param {{ userDataDir?: string }} [launchExtras]
 */
export function getPuppeteerLaunchOptions(headless, launchExtras = {}) {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    ...config.extraLaunchArgs(),
  ];
  /** @type {import('puppeteer').LaunchOptions} */
  const base = { headless, args, ...launchExtras };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return { ...base, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH };
  }

  let bundled = '';
  try {
    bundled = puppeteer.executablePath();
  } catch {
    /* no pinned revision */
  }
  if (bundled && existsSync(bundled)) {
    return { ...base, executablePath: bundled };
  }

  logger.info(
    'Using system Google Chrome (Chrome-for-Testing not in Puppeteer cache). Optional: npx puppeteer browsers install chrome',
  );
  return { ...base, channel: 'chrome' };
}

/** Remove stale Chrome singleton locks so a new scrape can start. */
function clearProfileLocks() {
  for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(profileDir, file);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* another Chrome instance may still be running */
      }
    }
  }
}

/**
 * @param {boolean} headless
 * @param {{ useProfile?: boolean }} [options]
 */
export async function launchLinkedInBrowser(headless, options = {}) {
  if (options.useProfile) clearProfileLocks();
  const launchExtras = options.useProfile ? { userDataDir: profileDir } : {};
  return puppeteer.launch(getPuppeteerLaunchOptions(headless, launchExtras));
}

/**
 * @param {import('puppeteer').Page} page
 */
export async function preparePage(page) {
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

export async function humanDelay() {
  await sleep(randomBetween(config.minDelayMs, config.maxDelayMs));
}

/**
 * Parse Cookie header or raw "a=b; c=d" / single pair string into Puppeteer cookie objects.
 * @param {string} cookieStr
 * @returns {import('puppeteer').CookieParam[]}
 */
export function parseCookieString(cookieStr) {
  const trimmed = cookieStr.trim();
  if (!trimmed) return [];

  // Bare token pasted without "li_at=" — treat whole string as li_at value.
  if (!trimmed.includes('=')) {
    return [
      {
        name: 'li_at',
        value: trimmed,
        domain: '.linkedin.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ];
  }

  const segments = trimmed.includes(';')
    ? trimmed.split(';').map((s) => s.trim()).filter(Boolean)
    : [trimmed];

  /** @type {import('puppeteer').CookieParam[]} */
  const out = [];

  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    if (!name) continue;

    out.push({
      name,
      value,
      domain: '.linkedin.com',
      path: '/',
      secure: true,
      httpOnly: HTTP_ONLY_COOKIE_NAMES.has(name),
      sameSite: 'Lax',
    });
  }

  return out;
}

/**
 * Cookie-based login: land on linkedin.com, set cookies, warm up on /feed/.
 * @param {import('puppeteer').Page} page
 * @param {string} cookieStr
 */
export async function authenticate(page, cookieStr) {
  const cookies = parseCookieString(cookieStr);
  if (!cookies.length) {
    throw new Error(
      'No cookie pairs parsed. Use li_at=...; JSESSIONID=... (copy full Cookie header from DevTools), or run: npm run login',
    );
  }

  await page.goto('https://www.linkedin.com/', {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs,
  });
  await page.setCookie(...cookies);
  await page.goto('https://www.linkedin.com/feed/', {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs,
  });
  await sleep(randomBetween(1500, 2500));
}

/**
 * Profile-based session: reuse saved Chrome login (no pasted li_at).
 * @param {import('puppeteer').Page} page
 */
export async function authenticateWithProfile(page) {
  await page.goto('https://www.linkedin.com/feed/', {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs,
  });
  await sleep(randomBetween(1000, 2000));
  if (await detectSessionWall(page)) {
    throw new SessionWallError(
      'Not logged in in the saved browser profile. Run: npm run login — sign in once in that window, then scrape again.',
    );
  }
}

/**
 * @param {string} href
 * @returns {string | null}
 */
export function normalizeProfileUrl(href) {
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('linkedin.com')) return null;

    let pathname = u.pathname.replace(/\/+$/, '') || '/';
    const m = pathname.match(/^\/in\/([^/]+)$/i);
    if (!m) return null;
    const slug = m[1];
    if (!slug || slug.toLowerCase() === 'unavailable') return null;

    return `https://www.linkedin.com/in/${slug}/`;
  } catch {
    return null;
  }
}

/** @param {string} url */
export function isValidProfileUrl(url) {
  return /^https:\/\/(www\.)?linkedin\.com\/in\/[^/]+\/?$/i.test(url);
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} url
 */
export async function navigateToUrl(page, url) {
  let lastErr = /** @type {Error | null} */ (null);
  for (let attempt = 1; attempt <= config.navigationRetries; attempt++) {
    try {
      await page.goto(url, {
        waitUntil: config.waitUntil,
        timeout: config.navigationTimeoutMs,
      });
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      logger.warn(`Navigation attempt ${attempt}/${config.navigationRetries} failed`, {
        message: lastErr.message,
      });
      if (attempt < config.navigationRetries) {
        await sleep(config.navigationBackoffMs * attempt);
      }
    }
  }
  throw new NavigationError(
    lastErr ? `Failed to load page after retries: ${lastErr.message}` : 'Failed to load page after retries',
  );
}

/**
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
export async function detectSessionWall(page) {
  const current = page.url();
  if (/linkedin\.com\/(login|u\/login|checkpoint|authwall)/i.test(current)) {
    return true;
  }

  return page.evaluate(() => {
    const pwd = document.querySelector('input[type="password"], input#password');
    const title = document.title || '';
    if (/sign in to linkedin/i.test(title) && pwd) return true;
    if (document.querySelector('[data-id="sign-in-form"]')) return true;
    if (document.querySelector('form[action*="checkpoint"]')) return true;
    return false;
  });
}

/**
 * @typedef {object} RawPersonRow
 * @property {string} href
 * @property {string} name
 * @property {string | null} connectionDegree
 * @property {string | null} company1
 * @property {string | null} company2
 * @property {string | null} company3
 * @property {string | null} about
 */

/**
 * Raw rows from DOM (href may be relative). Includes degree, up to 3 company names from card links, and headline/about text when visible.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<RawPersonRow[]>}
 */
export async function extractPeopleData(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    /** @type {RawPersonRow[]} */
    const rows = [];
    const anchors = document.querySelectorAll('a[href*="/in/"]');
    const seenHref = new Set();

    anchors.forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!href || href.includes('/in/unavailable')) return;
      if (seenHref.has(href)) return;
      seenHref.add(href);

      let name = (
        a.getAttribute('aria-label') ||
        a.getAttribute('title') ||
        ''
      ).trim();

      const card =
        a.closest('li') ||
        a.closest('article') ||
        a.closest('[data-chameleon-result-urn]');

      let bounded = card;
      if (!bounded) {
        let el = a.parentElement;
        for (let depth = 0; depth < 8 && el; depth += 1, el = el.parentElement) {
          const t = norm(el.innerText || '');
          if (t.length > 40 && t.length < 3500) {
            bounded = el;
            break;
          }
        }
      }

      if (!name && bounded) {
        const strong = bounded.querySelector('strong');
        if (strong) name = norm(strong.textContent || '');
      }

      if (!name) {
        name = norm(a.textContent || '');
      }

      const root = bounded || a.parentElement || document.body;
      const blockText = root.innerText || '';

      let connectionDegree = null;
      const degMatch = blockText.match(/\b(1st|2nd|3rd\+?)\b/i);
      if (degMatch) connectionDegree = degMatch[1];

      const companySeen = new Set();
      /** @type {string[]} */
      const companies = [];
      root.querySelectorAll('a[href*="/company/"]').forEach((link) => {
        const cn = norm(link.innerText || link.getAttribute('aria-label') || '');
        if (cn.length < 2 || cn.length > 160) return;
        if (/view all employees|see all/i.test(cn)) return;
        const key = cn.toLowerCase();
        if (companySeen.has(key)) return;
        companySeen.add(key);
        companies.push(cn);
      });

      const company1 = companies[0] || null;
      const company2 = companies[1] || null;
      const company3 = companies[2] || null;

      const rawLines = blockText.split(/\n+/).map(norm).filter(Boolean);
      const skipLine = (l) => {
        if (!l) return true;
        if (/^provides services\b/i.test(l)) return true;
        if (/^(1st|2nd|3rd\+?)$/i.test(l)) return true;
        if (/^(connect|follow|message)$/i.test(l)) return true;
        if (/mutual connection/i.test(l)) return true;
        if (/^see your mutual connections$/i.test(l)) return true;
        if (/^following$/i.test(l)) return true;
        return false;
      };
      const candidates = rawLines.filter((l) => !skipLine(l));

      // LinkedIn often puts "Provides services - …" on the link; real name is another line on the card.
      if (/^provides services\b/i.test(name) || !name || name.length > 120) {
        const personName = candidates.find(
          (l) =>
            l.length >= 3 &&
            l.length <= 80 &&
            !/@/.test(l) &&
            !/\|/.test(l) &&
            !/^(sales|account|business|senior|manager|director|development)/i.test(l),
        );
        name = personName || candidates.find((l) => l.length <= 80) || 'Pending profile';
      }

      const skipLineAfterName = (l) => {
        if (!l || l === name) return true;
        return skipLine(l);
      };
      const candidatesForAbout = rawLines.filter((l) => !skipLineAfterName(l));
      let about = candidatesForAbout.find((l) => l.length > 15) || null;
      if (!about && candidatesForAbout.length) {
        about = candidatesForAbout.slice(0, 4).join(' — ');
      }
      if (about && about.length > 800) {
        about = about.slice(0, 800);
      }

      rows.push({
        href,
        name,
        connectionDegree,
        company1,
        company2,
        company3,
        about,
      });
    });

    return rows;
  });
}

/** @param {import('puppeteer').Page} page */
export async function scrapeInitialPage(page) {
  return extractPeopleData(page);
}

/**
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if a button was clicked
 */
export async function clickShowMore(page) {
  await humanDelay();
  let clicked = false;
  try {
    clicked = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      /** LinkedIn company People tab uses a pill like "Show more results". */
      const matchesShowMore = (el) => {
        const t = norm(el.innerText || el.textContent);
        const aria = norm(el.getAttribute('aria-label'));
        return (
          /show\s+more(\s+results)?/i.test(t) ||
          /show\s+more(\s+results)?/i.test(aria)
        );
      };

      const candidates = [
        ...document.querySelectorAll('button, [role="button"]'),
      ];
      const target = candidates.find((el) => matchesShowMore(el));
      if (target) {
        const disabled =
          target.getAttribute('disabled') != null ||
          target.hasAttribute('disabled') ||
          target.getAttribute('aria-disabled') === 'true';
        if (!disabled) {
          target.click();
          return true;
        }
      }
      return false;
    });
  } catch (err) {
    logger.warn('clickShowMore failed', { message: err instanceof Error ? err.message : String(err) });
  }
  if (clicked) {
    // Let DOM update / results render.
    await sleep(randomBetween(700, 1200));
    try {
      await page.evaluate(() => {
        // Scroll a bit to keep the newly loaded cards in view.
        window.scrollBy(0, 400);
      });
    } catch {
      /* ignore */
    }
  }
  await humanDelay();
  return clicked;
}

/**
 * @param {import('puppeteer').Page} page
 * @returns {Promise<number>}
 */
export async function countProfileAnchors(page) {
  try {
    return await page.evaluate(() => document.querySelectorAll('a[href*="/in/"]').length);
  } catch {
    return 0;
  }
}

/**
 * Wait briefly for new people cards to render after clicking "Show more results".
 * @param {import('puppeteer').Page} page
 * @param {number} prevAnchorCount
 */
export async function waitForMoreResults(page, prevAnchorCount) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const next = await countProfileAnchors(page);
    if (next > prevAnchorCount + 3) return true;
  }
  return false;
}

/** @param {import('puppeteer').Page} page */
export async function scrollAndLoad(page) {
  await humanDelay();
  try {
    for (let i = 0; i < config.scrollRounds; i++) {
      await page.evaluate(
        (step) => {
          window.scrollBy(0, step);
        },
        config.scrollStepPx,
      );
      await sleep(config.scrollPauseMs);
    }
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(config.scrollPauseMs);
  } catch (err) {
    logger.warn('scrollAndLoad failed', { message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * @typedef {object} ExperienceRecord
 * @property {string | null} title
 * @property {string | null} company
 * @property {string | null} dates
 * @property {string | null} location
 * @property {string | null} description
 */

/**
 * @typedef {object} PersonRecord
 * @property {string} name
 * @property {string} fullName
 * @property {string} profileUrl
 * @property {string | null} title
 * @property {string | null} connectionDegree
 * @property {string | null} company1
 * @property {string | null} company2
 * @property {string | null} company3
 * @property {string | null} about
 * @property {ExperienceRecord[]} experiences
 * @property {CompanyExperience | null} [motiveExperience]
 * @property {boolean} [profileEnriched]
 */

/**
 * @typedef {object} CompanyRole
 * @property {string | null} title
 * @property {string | null} dates
 * @property {string | null} description
 */

/**
 * @typedef {object} CompanyExperience
 * @property {string} company
 * @property {string | null} employmentType
 * @property {string | null} location
 * @property {string | null} [companyUrl]
 * @property {CompanyRole[]} roles
 */

/**
 * Merge raw rows into a Map keyed by normalized profile path.
 * @param {Map<string, PersonRecord>} map
 * @param {RawPersonRow[]} rows
 */
export function mergePeopleRows(map, rows) {
  for (const row of rows) {
    const profileUrl = normalizeProfileUrl(row.href);
    if (!profileUrl || !isValidProfileUrl(profileUrl)) continue;
    const name = row.name.trim();
    if (!name) continue;

    let key;
    try {
      key = new URL(profileUrl).pathname.toLowerCase();
    } catch {
      key = profileUrl.toLowerCase();
    }

    /** @type {PersonRecord} */
    const incoming = {
      name,
      fullName: name,
      profileUrl,
      title: null,
      connectionDegree: row.connectionDegree || null,
      company1: row.company1 || null,
      company2: row.company2 || null,
      company3: row.company3 || null,
      about: row.about || null,
      experiences: [],
      motiveExperience: null,
      profileEnriched: false,
    };

    if (!map.has(key)) {
      map.set(key, incoming);
      continue;
    }

    const prev = map.get(key);
    if (!prev) continue;

    /** @type {PersonRecord} */
    const next = {
      ...prev,
      name: prev.fullName || prev.name || incoming.name,
      fullName: prev.fullName || prev.name || incoming.name,
      profileUrl: prev.profileUrl,
      connectionDegree: prev.connectionDegree || incoming.connectionDegree,
      company1: prev.company1 || incoming.company1,
      company2: prev.company2 || incoming.company2,
      company3: prev.company3 || incoming.company3,
      title: prev.title,
      experiences: prev.experiences?.length ? prev.experiences : incoming.experiences,
      profileEnriched: prev.profileEnriched,
    };
    if (!prev.profileEnriched && incoming.about && (!prev.about || incoming.about.length > (prev.about || '').length)) {
      next.about = incoming.about;
    }
    map.set(key, next);
  }
}

/**
 * Scroll the profile page until the About section is in view.
 * @param {import('puppeteer').Page} page
 */
export async function scrollToAboutSection(page) {
  try {
    await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const anchor =
        document.querySelector('#about') ||
        [...document.querySelectorAll('h2, h3')].find((h) =>
          /^about$/i.test(norm(h.innerText || h.textContent)),
        );
      anchor?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    await sleep(randomBetween(600, 1000));
    await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('button, a, span[role="button"]')];
      const seeMore = buttons.find((el) => {
        const t = norm(el.innerText || el.textContent);
        return /^see more$/i.test(t) || /^show more$/i.test(t);
      });
      const aboutRoot =
        document.querySelector('#about')?.closest('section') ||
        document.querySelector('[data-testid*="about"]');
      if (seeMore && aboutRoot?.contains(seeMore)) seeMore.click();
    });
    await sleep(randomBetween(500, 900));
  } catch {
    /* ignore */
  }
}

/**
 * Scrape the About section from the open profile page.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string | null>}
 */
export async function scrapeProfileAbout(page) {
  await scrollToAboutSection(page);

  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    /** @param {string} label */
    const findSection = (label) => {
      const re = new RegExp(`^\\s*${label}\\s*$`, 'i');
      const anchor = document.querySelector(`#${label.toLowerCase()}`);
      if (anchor) {
        return anchor.closest('section') || anchor.parentElement?.parentElement || anchor.parentElement;
      }
      for (const h of document.querySelectorAll('h2, h3')) {
        const headingText = norm(h.innerText || h.textContent || '');
        if (re.test(headingText)) {
          return h.closest('section') || h.parentElement?.parentElement || h.parentElement;
        }
      }
      return null;
    };

    const pickAboutText = (root) => {
      if (!root) return null;
      const expandable = root.querySelector(
        '[data-testid="expandable-text-box"], [data-testid*="about"] span[dir]',
      );
      if (expandable) {
        const t = norm(expandable.innerText || expandable.textContent);
        if (t.length > 15) return t.slice(0, 5000);
      }
      const clone = root.cloneNode(true);
      clone
        .querySelectorAll('button, a[href*="about"], h2, h3, [aria-label*="about" i]')
        .forEach((el) => el.remove());
      const text = norm(clone.innerText || '').replace(/^about\s*/i, '');
      if (text.length > 15) return text.slice(0, 5000);
      return null;
    };

    let about = pickAboutText(findSection('about'));

    if (!about) {
      const byTestId = document.querySelector('[data-testid*="about-i18n"], [data-testid*="About"]');
      about = pickAboutText(byTestId?.closest('section') || byTestId?.parentElement);
    }

    if (!about) {
      const anchor = document.querySelector('#about');
      about = pickAboutText(anchor?.closest('section') || anchor?.parentElement);
    }

    return about;
  });
}

/**
 * Scroll the profile page until the Experience heading is in view.
 * @param {import('puppeteer').Page} page
 */
export async function scrollToExperienceSection(page) {
  try {
    await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const h2 = [...document.querySelectorAll('h2')].find((h) =>
        /^experience$/i.test(norm(h.innerText || h.textContent)),
      );
      const anchor =
        document.querySelector('#experience') ||
        document.querySelector('[data-testid*="ExperienceTopLevelSection"]') ||
        h2;
      anchor?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    await sleep(randomBetween(800, 1500));
    await page.evaluate(() => window.scrollBy(0, 200));
    await sleep(randomBetween(400, 700));
    await page.evaluate(() => window.scrollBy(0, 400));
    await sleep(randomBetween(300, 500));
  } catch {
    /* ignore */
  }
}

/**
 * Find Motive under Experience via logo (alt/src), company URL, or "Motive · …" text.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<CompanyExperience | null>}
 */
export async function scrapeCompanyExperience(
  page,
  aliases = config.targetCompanyAliases,
) {
  await scrollToExperienceSection(page);
  await expandExperienceSection(page);
  await page
    .waitForSelector('a[href*="3271606"], a[href*="/company/"], img[alt], svg[aria-label]', {
      timeout: 8000,
    })
    .catch(() => {});

  return page.evaluate((companyAliases) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const matchesCompany = (text, href) => {
      const t = (text || '').toLowerCase();
      const h = (href || '').toLowerCase();
      return companyAliases.some((a) => {
        const al = a.toLowerCase();
        return t.includes(al) || h.includes(`/company/${al}`) || h.includes(al.replace(/\s+/g, '-'));
      });
    };

    const isMotiveLogo = (el) => {
      if (!el) return false;
      const alt = (el.getAttribute('alt') || '').toLowerCase();
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const src = (el.getAttribute('src') || '').toLowerCase();
      if (/motive/.test(alt) || /motive/.test(label)) return true;
      if (/motive_inc_logo|3271606|motive-inc|keeptruckin/.test(src)) return true;
      const link = el.closest('a[href*="/company/"]');
      return link ? matchesCompany('', link.getAttribute('href') || '') : false;
    };

    const isJunkLine = (t) => !t || /^[·•\s]+$/.test(t) || t.length < 2;

    const isDateLine = (t) => {
      if (isJunkLine(t) || t.length > 140) return false;
      if (/\bpresent\b/i.test(t) && /\b(19|20)\d{2}\b/i.test(t)) return true;
      if (
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t) &&
        (/\b(19|20)\d{2}\b/i.test(t) || /\bpresent\b/i.test(t))
      ) {
        return true;
      }
      if (/\b(19|20)\d{2}\b/.test(t) && /\b(mos|yr|month|year)\b/i.test(t)) return true;
      if (/\d{4}\s*[-–]\s*(\d{4}|present)\b/i.test(t)) return true;
      return false;
    };

    const isLocationLine = (t) =>
      !isJunkLine(t) &&
      (t.includes(',') || /\bremote\b/i.test(t)) &&
      !isDateLine(t) &&
      !/^motive\b/i.test(t);

    const isEmploymentHeader = (t) =>
      !isJunkLine(t) &&
      !isDateLine(t) &&
      (/^(full-time|part-time|contract|internship|self-employed|freelance)$/i.test(t) ||
        (/full-time|part-time|contract|internship|self-employed|freelance/i.test(t) &&
          t.length < 40 &&
          !/^motive\s*·/i.test(t)));

    const isBadExperienceLine = (t) =>
      /^(contact info|education|skills|about|recommendations|activity|licenses|certifications)$/i.test(
        t,
      ) ||
      /\b(school|university|college|institute|academy|economics)\b/i.test(t);

    const isLikelyJobTitle = (t) =>
      !isJunkLine(t) &&
      !isBadExperienceLine(t) &&
      !isDateLine(t) &&
      !isLocationLine(t) &&
      !isEmploymentHeader(t) &&
      !/^motive\s*·/i.test(t) &&
      !matchesCompany(t, '') &&
      t.length >= 3 &&
      t.length <= 120 &&
      (t.match(/\|/g) || []).length < 2;

    const splitCompanyLine = (line) => {
      if (!line || !line.includes('·')) return { company: null, employmentType: null };
      const parts = line.split('·').map((p) => norm(p)).filter(Boolean);
      const head = parts[0] || '';
      if (!matchesCompany(head, '')) return { company: null, employmentType: null };
      return { company: head, employmentType: parts.slice(1).join(' · ') || null };
    };

    const companyHref = (root) => {
      const link = [...root.querySelectorAll('a[href*="/company/"]')].find((a) =>
        matchesCompany('', a.getAttribute('href') || ''),
      );
      const href = link?.getAttribute('href') || '';
      if (!href) return null;
      return href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
    };

    const getExperienceScope = () => {
      const walkUpForItems = (start) => {
        let el = start;
        for (let i = 0; i < 12 && el; i++) {
          if (el.querySelector('[componentkey*="entity-collection-item"]')) return el;
          el = el.parentElement;
        }
        return start?.closest('section') || start?.parentElement || start;
      };
      const anchor = document.querySelector('#experience');
      if (anchor) return walkUpForItems(anchor);
      const byTestId = document.querySelector('[data-testid*="Experience"]');
      if (byTestId) return walkUpForItems(byTestId);
      const h2 = [...document.querySelectorAll('h2')].find((h) =>
        /^experience$/i.test(norm(h.innerText || h.textContent)),
      );
      if (h2) return walkUpForItems(h2);
      return document.querySelector('main');
    };

    /** Must have Motive logo or /company/3271606 link — no text-only guesses. */
    /** @param {Element} root */
    const isMotiveBlock = (root) => {
      if (isBadExperienceLine(norm(root.innerText || '').split('\n')[0] || '')) return false;
      if ([...root.querySelectorAll('img, svg')].some(isMotiveLogo)) return true;
      return [...root.querySelectorAll('a[href*="/company/"]')].some((a) =>
        matchesCompany('', a.getAttribute('href') || ''),
      );
    };

    /** Prefer <p> nodes that contain Present or a month–year range (LinkedIn date row). */
    /** @param {Element} root */
    const findDateLine = (root, fallbackLines = []) => {
      for (const p of root.querySelectorAll('p')) {
        if (p.closest('ul')) continue;
        const t = norm(p.innerText);
        if (isDateLine(t)) return t;
      }
      for (const span of root.querySelectorAll('span[aria-hidden="true"]')) {
        const t = norm(span.textContent);
        if (isDateLine(t)) return t;
      }
      return fallbackLines.find((l) => isDateLine(l)) || null;
    };

    /** @param {object | null} parsed */
    const isValidMotiveResult = (parsed) => {
      if (!parsed?.company) return false;
      if (parsed.employmentType && isBadExperienceLine(parsed.employmentType)) return false;
      const roles = parsed.roles || [];
      if (roles.some((r) => r.title && isBadExperienceLine(r.title))) return false;
      if (parsed.companyUrl) return true;
      return roles.some((r) => r.dates);
    };

    /** @param {object | null} parsed @param {Element} root */
    const scoreMotiveResult = (parsed, root) => {
      if (!parsed) return -1;
      let score = 0;
      if (parsed.companyUrl) score += 50;
      if ([...root.querySelectorAll('img, svg')].some(isMotiveLogo)) score += 40;
      for (const r of parsed.roles || []) {
        if (r.dates) score += 35;
        if (r.title && isLikelyJobTitle(r.title)) score += 25;
        if (r.title && isBadExperienceLine(r.title)) score -= 200;
      }
      if (parsed.employmentType && !isBadExperienceLine(parsed.employmentType)) score += 5;
      if (parsed.employmentType && isBadExperienceLine(parsed.employmentType)) score -= 80;
      if (findDateLine(root, [])) score += 20;
      return score;
    };

    /** @param {Element} start */
    const findCardRoot = (start) => {
      const byItem = start.closest('[componentkey*="entity-collection-item"]');
      if (byItem) return byItem;
      let el = start;
      for (let depth = 0; depth < 16 && el; depth += 1) {
        if (el.getAttribute?.('componentkey')?.includes('entity-collection-item')) return el;
        const hasLogo = [...el.querySelectorAll('img, svg')].some(isMotiveLogo);
        const ps = [...el.querySelectorAll('p')].filter((p) => !p.closest('ul'));
        const companyLink = [...el.querySelectorAll('a[href*="/company/"]')].find((a) =>
          matchesCompany('', a.getAttribute('href') || ''),
        );
        if (companyLink && (hasLogo || ps.length >= 2)) return el;
        el = el.parentElement;
      }
      return start.closest('[componentkey]') || start.parentElement || start;
    };

    /** @param {Element} root */
    const collectLines = (root) => {
      /** @type {string[]} */
      const lines = [];
      root.querySelectorAll('p').forEach((p) => {
        if (p.closest('ul')) return;
        const t = norm(p.innerText);
        if (t && !isJunkLine(t) && t.length < 500 && !/^experience$/i.test(t)) lines.push(t);
      });
      if (lines.length < 2) {
        norm(root.innerText)
          .split('\n')
          .map(norm)
          .filter((l) => !isJunkLine(l) && !/^experience$/i.test(l))
          .forEach((l) => lines.push(l));
      }
      return [...new Set(lines)];
    };

    /** Grouped Motive block (multiple roles under one company) — matches 07-25 successful runs. */
    /** @param {Element} root */
    const parseGroupedMotiveBlock = (root) => {
      if (!isMotiveBlock(root)) return null;

      const href = companyHref(root);
      const allLines = collectLines(root);

      let company = 'Motive';
      let employmentType =
        allLines.find(
          (l) =>
            isEmploymentHeader(l) &&
            !isDateLine(l) &&
            !isBadExperienceLine(l) &&
            !matchesCompany(l, ''),
        ) || null;
      const companyLine = allLines.find((l) => matchesCompany(l, href || '') || /^motive\s*·/i.test(l));
      if (companyLine) {
        const split = splitCompanyLine(companyLine);
        if (split.company) {
          company = split.company;
          if (!employmentType) employmentType = split.employmentType;
        }
      }

      const location =
        allLines.find((l) => isLocationLine(l) && !employmentType?.includes(l)) || null;

      /** @type {CompanyRole[]} */
      const roles = [];
      root.querySelectorAll('ul li').forEach((li) => {
        const ps = [...li.querySelectorAll('p, span[aria-hidden="true"]')]
          .map((el) => norm(el.innerText || el.textContent))
          .filter((t) => !isJunkLine(t));
        if (!ps.length) return;
        const dates = findDateLine(li, ps) || ps.find((t) => isDateLine(t)) || null;
        const title =
          ps.find(
            (t) =>
              t !== dates &&
              isLikelyJobTitle(t) &&
              !/skills$/i.test(t),
          ) || ps.find((t) => t !== dates && !matchesCompany(t, '')) || null;
        const descEl = li.querySelector('[data-testid="expandable-text-box"]');
        const description = descEl ? norm(descEl.innerText).slice(0, 2000) : null;
        if (title && !isJunkLine(title)) roles.push({ title, dates, description });
      });

      if (!roles.length) return null;

      return {
        company,
        employmentType,
        location,
        roles,
        companyUrl: href,
      };
    };

    /** Single-role Motive card (logo + title / Motive · Full-time / dates / location). */
    /** @param {Element} root */
    const parseSingleMotiveBlock = (root) => {
      if (!isMotiveBlock(root)) return null;

      const href = companyHref(root);
      const unique = collectLines(root);
      if (!unique.length && !href) return null;

      const companyLine = unique.find(
        (l) => matchesCompany(l, href || '') || /^motive\s*·/i.test(l),
      );
      let company = 'Motive';
      let employmentType = null;
      if (companyLine) {
        const split = splitCompanyLine(companyLine);
        if (split.company) {
          company = split.company;
          employmentType = split.employmentType;
        }
      }

      const dates = findDateLine(root, unique) || null;
      const location = unique.find((l) => isLocationLine(l)) || null;
      const used = new Set([companyLine, dates, location].filter(Boolean));
      const title = unique.find((l) => !used.has(l) && isLikelyJobTitle(l)) || null;

      if (employmentType && /^motive\s*·/i.test(employmentType)) {
        const split = splitCompanyLine(employmentType);
        employmentType = split.employmentType;
      }
      if (!employmentType) {
        const empLine = unique.find(
          (l) => !used.has(l) && l !== title && /^motive\s*·/i.test(l),
        );
        if (empLine) employmentType = splitCompanyLine(empLine).employmentType;
      }
      if (!employmentType) {
        employmentType =
          unique.find((l) => !used.has(l) && l !== title && isEmploymentHeader(l)) || null;
      }

      /** @type {CompanyRole[]} */
      const roles = [];
      if (title || dates) roles.push({ title, dates, description: null });

      if (!href && !dates && !roles.length) return null;
      if (!roles.length && !dates) return null;

      return {
        company,
        employmentType,
        location,
        roles,
        companyUrl: href,
      };
    };

    /** @param {Element} root */
    const parseMotiveBlock = (root) => parseGroupedMotiveBlock(root) || parseSingleMotiveBlock(root);

    const scope = getExperienceScope();
    if (!scope) return null;

    let blocks = [...scope.querySelectorAll('[componentkey*="entity-collection-item"]')];
    /** @type {{ parsed: object, score: number }[]} */
    const candidates = [];
    const seen = new Set();

    const tryBlock = (block) => {
      const key = block.getAttribute('componentkey') || block.innerText?.slice(0, 100);
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      if (!isMotiveBlock(block)) return;
      const parsed = parseMotiveBlock(block);
      const score = scoreMotiveResult(parsed, block);
      if (parsed && score > 0) candidates.push({ parsed, score });
    };

    for (const block of blocks) tryBlock(block);

    /** @type {Element[]} */
    const markers = [];
    scope.querySelectorAll('img, svg').forEach((el) => {
      if (isMotiveLogo(el)) markers.push(el);
    });
    scope.querySelectorAll('a[href*="/company/"]').forEach((a) => {
      if (matchesCompany('', a.getAttribute('href') || '')) markers.push(a);
    });

    for (const marker of markers) {
      tryBlock(findCardRoot(marker));
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates.find((c) => isValidMotiveResult(c.parsed));
    return best?.parsed ?? null;
  }, aliases);
}

/** @param {CompanyExperience | null | undefined} motive */
export function isValidMotiveExperience(motive) {
  if (!motive?.company) return false;
  const badTitle = /^(contact info|education|skills|about|recommendations|activity)$/i;
  const badWord = /\b(school|university|college|institute|academy|economics|contact info)\b/i;
  if (motive.employmentType && badWord.test(motive.employmentType)) return false;
  for (const r of motive.roles || []) {
    if (r.title && (badTitle.test(r.title) || badWord.test(r.title))) return false;
  }
  if (motive.companyUrl) return true;
  return (motive.roles || []).some((r) => r.dates && /\d{4}/.test(r.dates));
}

/** @param {CompanyExperience | null} motive */
export function companyExperienceToRecords(motive) {
  if (!motive) return [];
  if (motive.roles?.length) {
    return motive.roles.map((r) => ({
      title: r.title,
      company: motive.company,
      dates: r.dates,
      location: motive.location,
      description: r.description,
    }));
  }
  return [
    {
      title: null,
      company: motive.company,
      dates: motive.employmentType,
      location: motive.location,
      description: null,
    },
  ];
}

export async function expandExperienceSection(page) {
  try {
    await page.evaluate(() => {
      document.querySelector('#experience')?.scrollIntoView({ block: 'center' });
    });
    await sleep(randomBetween(600, 1000));
    await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('button, a, span[role="button"]')];
      const expand = buttons.find((el) => {
        const t = norm(el.innerText || el.textContent);
        return /show all \d+ experiences|see all experiences|show all experience/i.test(t);
      });
      if (expand) expand.click();
    });
    await sleep(randomBetween(1000, 1800));
  } catch {
    /* ignore */
  }
}

/**
 * Parse experience list from current profile or /details/experience/ page.
 * @param {import('puppeteer').Page} page
 */
/** @param {string} profileUrl */
export function experienceDetailsUrl(profileUrl) {
  return profileUrl.replace(/\/?$/, '/details/experience/');
}

export async function scrapeExperiencesFromPage(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    /** @type {ExperienceRecord[]} */
    const experiences = [];
    const seen = new Set();

    const add = (title, company, dates, location, description) => {
      const t = norm(title);
      if (!t || t.length < 2) return;
      if (/^(experience|show all|see all)/i.test(t)) return;
      const key = `${t}|${norm(company)}|${norm(dates)}`;
      if (seen.has(key)) return;
      seen.add(key);
      experiences.push({
        title: t,
        company: norm(company) || null,
        dates: norm(dates) || null,
        location: norm(location) || null,
        description: norm(description)?.slice(0, 2000) || null,
      });
    };

    document.querySelectorAll('main li').forEach((li) => {
      const spans = [...li.querySelectorAll('span[aria-hidden="true"]')]
        .map((s) => norm(s.textContent))
        .filter((t) => t.length > 1);
      if (spans.length < 2) return;
      const dates =
        spans.find((s) => /\b(19|20)\d{2}|present/i.test(s) && s.length < 90) || spans[2] || null;
      add(spans[0], spans[1], dates, null, spans.slice(3).join(' ') || null);
    });

    document
      .querySelectorAll('.pvs-entity, li.pvs-list__paged-list-item, li.artdeco-list__item')
      .forEach((entity) => {
        const titleEl = entity.querySelector(
          '.t-bold span[aria-hidden="true"], .hoverable-link-text span[aria-hidden="true"], a[data-field="experience_title"] span[aria-hidden="true"]',
        );
        const companyEl = entity.querySelector(
          '.t-14.t-normal span[aria-hidden="true"], .t-black--light span[aria-hidden="true"], a[data-field="experience_company"] span[aria-hidden="true"]',
        );
        const dateEl = entity.querySelector(
          '.pvs-entity__caption-wrapper span[aria-hidden="true"], .t-14.t-normal.t-black--light span[aria-hidden="true"]',
        );
        const title = titleEl?.textContent || '';
        const company = companyEl?.textContent || '';
        const dates = dateEl?.textContent || '';
        if (title && (company || dates)) {
          add(title, company, dates, null, null);
          return;
        }

        const lines = (entity.innerText || '')
          .split('\n')
          .map(norm)
          .filter((l) => l && !/^experience$/i.test(l));
        if (lines.length < 2) return;
        const datesLine =
          lines.find((l) =>
            /\b(19|20)\d{2}|present|yr|mos/i.test(l),
          ) || null;
        add(lines[0], lines[1], datesLine, null, null);
      });

    return experiences;
  });
}

/**
 * Scrape full profile: fullName, title (headline), about, all experiences.
 * @param {import('puppeteer').Page} page
 */
export async function extractProfileDetails(page) {
  const profileUrl = page.url().split('?')[0].replace(/\/$/, '');

  await expandExperienceSection(page);

  const base = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    /** @param {string} label */
    const findSection = (label) => {
      const re = new RegExp(`^\\s*${label}\\s*$`, 'i');
      const anchor = document.querySelector(`#${label.toLowerCase()}`);
      if (anchor) {
        return anchor.closest('section') || anchor.parentElement;
      }
      for (const h of document.querySelectorAll('h2, h3')) {
        const headingText = norm(h.innerText || h.textContent || '');
        if (re.test(headingText)) {
          return h.closest('section') || h.parentElement;
        }
      }
      return null;
    };

    let fullName =
      norm(document.querySelector('h1.text-heading-xlarge')?.innerText) ||
      norm(document.querySelector('main h1')?.innerText) ||
      norm(document.querySelector('h1')?.innerText) ||
      '';

    let title = null;
    const topCard =
      document.querySelector('section.pv-top-card') ||
      document.querySelector('main section') ||
      document.querySelector('main');
    if (topCard) {
      for (const el of topCard.querySelectorAll('.text-body-medium, [data-generated-suggestion-target]')) {
        const t = norm(el.innerText || el.textContent);
        if (
          t &&
          t !== fullName &&
          t.length < 320 &&
          !/^\d+(\.\d+)?\s*(followers|connections)/i.test(t) &&
          !/^provides services/i.test(t)
        ) {
          title = t;
          break;
        }
      }
    }

    return { fullName, title };
  });

  const about = await scrapeProfileAbout(page);

  let experiences = await scrapeExperiencesFromPage(page);

  if (!experiences.length && profileUrl.includes('/in/')) {
    try {
      await page.goto(`${profileUrl}/details/experience/`, {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs,
      });
      await sleep(randomBetween(1200, 2000));
      await expandExperienceSection(page);
      experiences = await scrapeExperiencesFromPage(page);
    } catch {
      /* keep empty */
    }
  }

  return { ...base, about, experiences };
}

/**
 * @param {PersonRecord} person
 * @param {Awaited<ReturnType<typeof extractProfileDetails>>} details
 */
export function applyProfileDetails(person, details) {
  if (details.fullName) {
    person.fullName = details.fullName;
    person.name = details.fullName;
  }
  if (details.title) person.title = details.title;
  if (details.about && (!person.about || details.about.length >= (person.about || '').length)) {
    person.about = details.about;
  }
  if (details.motiveExperience) {
    person.motiveExperience = details.motiveExperience;
    person.experiences = companyExperienceToRecords(details.motiveExperience);
  } else if (details.experiences?.length) {
    person.experiences = details.experiences;
  }
  person.profileEnriched = true;
}

/**
 * Visit each profile URL and enrich records; saves JSONL after each person.
 * @param {import('puppeteer').Page} page
 * @param {Map<string, PersonRecord>} map
 * @param {Awaited<ReturnType<typeof createIncrementalWriter>>} writer
 * @param {number} maxPeople
 */
export async function enrichProfilesFromPages(page, map, writer, maxPeople) {
  const entries = [...map.entries()].slice(0, maxPeople);
  let done = 0;

  for (const [key, person] of entries) {
    if (person.profileEnriched && isValidMotiveExperience(person.motiveExperience)) {
      done += 1;
      continue;
    }

    logger.info(`Enriching profile ${done + 1}/${entries.length}`, {
      profileUrl: person.profileUrl,
    });

    try {
      await page.goto(person.profileUrl, {
        waitUntil: config.waitUntil,
        timeout: config.navigationTimeoutMs,
      });
      await sleep(randomBetween(800, 1200));
      await page.waitForSelector('main, h1', { timeout: 15_000 }).catch(() => {});

      if (await detectSessionWall(page)) {
        throw new SessionWallError('Session lost while opening profiles. Run npm run login again.');
      }

      const base = await page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const fullName =
          norm(document.querySelector('h1')?.innerText) ||
          norm(document.querySelector('main h1')?.innerText) ||
          '';
        let title = null;
        for (const el of document.querySelectorAll('.text-body-medium, [data-generated-suggestion-target]')) {
          const t = norm(el.innerText);
          if (t && t !== fullName && t.length < 320 && !/followers|connections/i.test(t)) {
            title = t;
            break;
          }
        }
        return { fullName, title };
      });

      const about = await scrapeProfileAbout(page);

      let motiveExperience = await scrapeCompanyExperience(page);

      if (!isValidMotiveExperience(motiveExperience)) {
        motiveExperience = null;
        try {
          await page.goto(experienceDetailsUrl(person.profileUrl), {
            waitUntil: 'domcontentloaded',
            timeout: config.navigationTimeoutMs,
          });
          await sleep(randomBetween(2000, 3500));
          motiveExperience = await scrapeCompanyExperience(page);
        } catch {
          /* keep null */
        }
      }

      /** @type {Awaited<ReturnType<typeof extractProfileDetails>>} */
      const details = {
        ...base,
        about: about || person.about || null,
        motiveExperience,
        experiences: [],
      };

      if (motiveExperience) {
        logger.info(`Found ${config.targetCompanyName} experience`, {
          profileUrl: person.profileUrl,
          company: motiveExperience.company,
          employmentType: motiveExperience.employmentType,
          title: motiveExperience.roles?.[0]?.title ?? null,
          dates: motiveExperience.roles?.[0]?.dates ?? null,
        });
      } else {
        logger.warn(`No ${config.targetCompanyName} experience block found`, {
          profileUrl: person.profileUrl,
        });
      }

      applyProfileDetails(person, details);
      map.set(key, person);

      await writer.rewritePeople([...map.values()]);
      await writer.writeMeta({
        updatedAt: new Date().toISOString(),
        phase: 'profile-enrichment',
        enrichedCount: [...map.values()].filter((p) => p.profileEnriched).length,
        totalUniquePeople: map.size,
        jsonlPath: writer.jsonlPath,
      });
    } catch (err) {
      logger.warn('Profile enrich failed', {
        profileUrl: person.profileUrl,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof SessionWallError) throw err;
    }

    done += 1;
    await sleep(randomBetween(config.profileDelayMinMs, config.profileDelayMaxMs));
  }
}

/**
 * @param {string} cookieStr
 * @param {string} url
 * @param {{
 *   maxPeople?: number;
 *   format?: 'json' | 'csv' | 'both';
 *   headless?: boolean;
 *   useProfile?: boolean;
 * }} [options]
 */
export async function run(cookieStr, url, options = {}) {
  const maxPeople = options.maxPeople ?? config.maxPeople;
  const headless = options.headless ?? config.headless;
  const useProfile = options.useProfile ?? config.useProfile;

  if (!useProfile && !(cookieStr || '').trim()) {
    throw new Error(
      'No cookie provided. Set LINKEDIN_COOKIE / constants.local.js, or use --profile / npm run login',
    );
  }

  let browser = /** @type {import('puppeteer').Browser | null} */ (null);
  /** @type {(() => Promise<void>) | null} */
  let sigintHandler = null;

  try {
    browser = await launchLinkedInBrowser(headless, { useProfile });

    sigintHandler = async () => {
      logger.warn('SIGINT received, closing browser…');
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
      process.exit(130);
    };
    process.once('SIGINT', sigintHandler);

    const page = await browser.newPage();
    await preparePage(page);

    if (useProfile) {
      logger.info('Using saved browser profile (no cookie injection).');
      await authenticateWithProfile(page);
    } else {
      await authenticate(page, cookieStr);
    }
    await navigateToUrl(page, url);

    await sleep(randomBetween(500, 1000));
    await page.waitForSelector('body', { timeout: 10_000 }).catch(() => {});

    if (await detectSessionWall(page)) {
      throw new SessionWallError(
        'Session not valid: redirected to login or checkpoint. Refresh LINKEDIN_COOKIE (e.g. li_at) from a logged-in browser.',
      );
    }

    /** @type {Map<string, PersonRecord>} */
    const map = new Map();
    let stallIterations = 0;

    const writer = await createIncrementalWriter();
    await writer.writeMeta({
      startedAt: new Date().toISOString(),
      sourceUrl: url,
      mode: useProfile ? 'profile' : 'cookie',
      jsonlPath: writer.jsonlPath,
    });
    logger.info('Incremental output enabled', {
      jsonlPath: writer.jsonlPath,
      metaPath: writer.metaPath,
    });

    while (map.size < maxPeople && stallIterations < config.stallIterations) {
      const countBefore = map.size;
      const anchorCountBefore = await countProfileAnchors(page);

      // Scroll first so lazy-loaded profile cards mount, then scrape the current batch.
      await scrollAndLoad(page);

      const rows = await extractPeopleData(page);
      mergePeopleRows(map, rows);

      logger.progressEvery(map.size, config.progressLogInterval);

      const peopleNow = [...map.values()];
      const { appended } = await writer.appendPeople(peopleNow);
      await writer.writeMeta({
        updatedAt: new Date().toISOString(),
        sourceUrl: url,
        totalUniquePeople: map.size,
        appendedLastWrite: appended,
        maxPeople,
        stallIterations,
        mode: useProfile ? 'profile' : 'cookie',
        jsonlPath: writer.jsonlPath,
      });

      if (map.size >= maxPeople) break;

      // After scraping everyone visible in this batch, click "Show more results" for the next batch.
      const clicked = await clickShowMore(page);
      const moreRendered = clicked ? await waitForMoreResults(page, anchorCountBefore) : false;
      if (!clicked) {
        // No button: attempt one deeper scroll; if still no growth, we will stall out naturally.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await sleep(randomBetween(400, 800));
      }

      const grewThisCycle = map.size > countBefore;
      // Don't count a stall if we successfully triggered more results and the page is still loading/rendering.
      const shouldStall = !grewThisCycle && !clicked && !moreRendered;
      if (shouldStall) {
        stallIterations += 1;
        logger.info(`No new people after load cycle (stall ${stallIterations}/${config.stallIterations})`);
      } else {
        stallIterations = 0;
      }
    }

    let people = [...map.values()].slice(0, maxPeople);

    if (config.scrapeProfiles && people.length > 0) {
      logger.info('Opening each profile for fullName, title, about, and experiences…', {
        count: people.length,
      });
      await enrichProfilesFromPages(page, map, writer, maxPeople);
      people = [...map.values()].slice(0, maxPeople);
      await writer.rewritePeople(people);
    }

    return {
      people,
      metadata: {
        scrapedAt: new Date().toISOString(),
        sourceUrl: url,
        totalCount: people.length,
        profileDetails: config.scrapeProfiles,
      },
    };
  } finally {
    if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
