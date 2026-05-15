import 'dotenv/config';
import {
  DEFAULT_LINKEDIN_COOKIE,
  DEFAULT_LINKEDIN_URL,
} from './constants.js';
import { config } from './config.js';
import { saveToFile } from './utils/fileHandler.js';
import * as logger from './utils/logger.js';
import {
  run,
  SessionWallError,
  NavigationError,
} from './scraper.js';

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
});

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ url?: string, cookie?: string, max?: number, batchSize?: number, parallelTabs?: number, format?: 'json'|'csv'|'both', headed?: boolean, profile?: boolean, help?: boolean }} */
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--cookie') out.cookie = argv[++i];
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--batch-size') out.batchSize = Number(argv[++i]);
    else if (a === '--parallel-tabs') out.parallelTabs = Number(argv[++i]);
    else if (a === '--format') out.format = /** @type {'json'|'csv'|'both'} */ (argv[++i]);
    else if (a === '--headed') out.headed = true;
    else if (a === '--profile') out.profile = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printUsage() {
  console.log(`
Usage:
  node index.js --cookie "<cookie string>" --url "<linkedin people url>"

Options:
  --profile   Use saved Chrome login (.linkedin-profile/) — run npm run login first
  --cookie    LinkedIn cookies: li_at=...; JSESSIONID=... (or set LINKEDIN_COOKIE)
  --url       Target People URL (or set LINKEDIN_URL)
  --max         Max unique people (default ${config.maxPeople}, hard cap ${config.maxPeopleLimit})
  --batch-size     List N people, enrich those profiles, repeat (default ${config.batchSize})
  --parallel-tabs  Profile enrichment tabs in parallel (default ${config.parallelTabs}, max ${config.parallelTabsMax})
  --format         json | csv | both (default json)
  --headed    Run browser non-headless for debugging
  -h, --help  Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const useProfile = args.profile || config.useProfile;
  const cookie =
    args.cookie ||
    process.env.LINKEDIN_COOKIE ||
    DEFAULT_LINKEDIN_COOKIE ||
    '';
  const url =
    args.url || process.env.LINKEDIN_URL || DEFAULT_LINKEDIN_URL || '';

  if (!url) {
    logger.error('Missing --url / LINKEDIN_URL');
    printUsage();
    process.exit(1);
  }

  if (!useProfile && !cookie) {
    logger.error('Missing cookie. Use --profile (after npm run login) or set LINKEDIN_COOKIE.');
    printUsage();
    process.exit(1);
  }

  if (!/^https:\/\/(www\.)?linkedin\.com\//i.test(url)) {
    logger.error('URL must be a https://www.linkedin.com/... link');
    process.exit(1);
  }

  const requestedMax =
    Number.isFinite(args.max) && args.max > 0 ? args.max : config.maxPeople;
  const maxPeople = Math.min(requestedMax, config.maxPeopleLimit);
  if (requestedMax > config.maxPeopleLimit) {
    logger.warn(`--max ${requestedMax} exceeds limit; using ${config.maxPeopleLimit}`);
  }
  const batchSize =
    args.batchSize !== undefined && Number.isFinite(args.batchSize) && args.batchSize >= 0
      ? args.batchSize
      : config.batchSize;
  const parallelTabs =
    args.parallelTabs !== undefined && Number.isFinite(args.parallelTabs) && args.parallelTabs > 0
      ? Math.min(args.parallelTabs, config.parallelTabsMax)
      : config.parallelTabs;
  const format = args.format || 'json';
  if (!['json', 'csv', 'both'].includes(format)) {
    logger.error('--format must be json, csv, or both');
    process.exit(1);
  }

  const headless = args.headed ? false : config.headless;

  logger.info('Starting scrape', {
    url,
    maxPeople,
    batchSize,
    parallelTabs,
    format,
    headless,
    useProfile,
  });

  try {
    const { people, metadata } = await run(cookie, url, {
      maxPeople,
      batchSize,
      parallelTabs,
      headless,
      useProfile,
    });

    if (!people.length) {
      logger.error('No people extracted. Cookie/session or DOM selectors may need attention.');
      process.exit(4);
    }

    const payload = { metadata, people };
    const paths = await saveToFile(payload, { format });
    logger.info('Saved output', paths);
    logger.info('Done', { totalCount: metadata.totalCount });
    process.exit(0);
  } catch (err) {
    if (err instanceof SessionWallError) {
      logger.error(err.message);
      process.exit(2);
    }
    if (err instanceof NavigationError) {
      logger.error(err.message);
      process.exit(3);
    }
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
