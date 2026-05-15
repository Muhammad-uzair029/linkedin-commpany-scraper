import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @returns {string[]} */
function extraLaunchArgs() {
  if (process.env.PUPPETEER_NO_SANDBOX === '1') {
    return ['--no-sandbox', '--disable-setuid-sandbox'];
  }
  return [];
}

/** Persistent Chrome profile — log in once with `npm run login`, reuse for scrape. */
export const profileDir = path.join(__dirname, '.linkedin-profile');

export const config = {
  outputDir: path.join(__dirname, 'output'),
  profileDir,
  useProfile: process.env.LINKEDIN_USE_PROFILE === '1',
  maxPeople: Number(process.env.MAX_PEOPLE) || 200,
  minDelayMs: 200,
  maxDelayMs: 500,
  navigationTimeoutMs: 60_000,
  navigationRetries: 3,
  navigationBackoffMs: 2000,
  waitUntil: /** @type {'domcontentloaded' | 'load' | 'networkidle0' | 'networkidle2'} */ (
    process.env.LINKEDIN_WAIT_UNTIL || 'domcontentloaded'
  ),
  scrollStepPx: 600,
  scrollRounds: 4,
  scrollPauseMs: 400,
  stallIterations: 5,
  progressLogInterval: 15,
  headless: process.env.HEADLESS !== '0',
  /** Visit each /in/ profile for fullName, title, about, experiences. */
  scrapeProfiles: process.env.LINKEDIN_SCRAPE_PROFILES !== '0',
  profileDelayMinMs: Number(process.env.PROFILE_DELAY_MIN_MS) || 1200,
  profileDelayMaxMs: Number(process.env.PROFILE_DELAY_MAX_MS) || 2800,
  /** Company name to match in Experience section (e.g. Motive). */
  targetCompanyName: process.env.TARGET_COMPANY_NAME || 'Motive',
  /** Also match href/text aliases (KeepTruckin rebranded to Motive). */
  targetCompanyAliases: ['Motive', 'KeepTruckin', 'motive-inc', 'keeptruckin', '3271606'],
  extraLaunchArgs,
};
