import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Incremental writer: append JSONL + periodically update a meta JSON file.
 * @param {{ baseName?: string }} [opts]
 */
export async function createIncrementalWriter(opts = {}) {
  await fs.mkdir(config.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = opts.baseName || `linkedin_people_live_${stamp}`;

  const jsonlPath = path.join(config.outputDir, `${base}.jsonl`);
  const metaPath = path.join(config.outputDir, `${base}.meta.json`);

  /** @type {Set<string>} */
  const seen = new Set();

  /**
   * @param {Array<{ profileUrl: string }>} people
   */
  async function appendPeople(people) {
    if (!people.length) return { appended: 0, jsonlPath, metaPath };
    let appended = 0;
    let chunk = '';
    for (const p of people) {
      const key = p.profileUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      chunk += `${JSON.stringify(p)}\n`;
      appended += 1;
    }
    if (chunk) {
      await fs.appendFile(jsonlPath, chunk, 'utf8');
    }
    return { appended, jsonlPath, metaPath };
  }

  /**
   * @param {object} meta
   */
  async function writeMeta(meta) {
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return { metaPath };
  }

  /**
   * Rewrite JSONL from the full in-memory set (used after profile enrichment updates).
   * @param {Array<{ profileUrl: string }>} people
   */
  async function rewritePeople(people) {
    seen.clear();
    let chunk = '';
    for (const p of people) {
      const key = p.profileUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      chunk += `${JSON.stringify(p)}\n`;
    }
    await fs.writeFile(jsonlPath, chunk, 'utf8');
    return { count: seen.size, jsonlPath, metaPath };
  }

  return {
    jsonlPath,
    metaPath,
    appendPeople,
    rewritePeople,
    writeMeta,
  };
}

/**
 * @param {{ metadata: object, people: Array<Record<string, unknown>> }} payload
 * @param {{ format?: 'json' | 'csv' | 'both' }} [opts]
 * @returns {Promise<{ jsonPath?: string, csvPath?: string }>}
 */
export async function saveToFile(payload, opts = {}) {
  const format = opts.format ?? 'json';
  await fs.mkdir(config.outputDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `linkedin_people_${stamp}`;
  const result = {};

  if (format === 'json' || format === 'both') {
    const jsonPath = path.join(config.outputDir, `${base}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
    result.jsonPath = jsonPath;
  }

  if (format === 'csv' || format === 'both') {
    const csvPath = path.join(config.outputDir, `${base}.csv`);
    const header =
      'fullName,title,about,profileUrl,motiveExperience,connectionDegree,experiences,company1,company2,company3';
    const lines = [header];
    for (const p of payload.people) {
      const fullName = /** @type {string} */ (p.fullName ?? p.name ?? '');
      lines.push(
        [
          escapeCsvField(fullName),
          escapeCsvField(/** @type {string} */ (p.title ?? '')),
          escapeCsvField(/** @type {string} */ (p.about ?? '')),
          escapeCsvField(p.profileUrl),
          escapeCsvField(JSON.stringify(p.motiveExperience ?? null)),
          escapeCsvField(/** @type {string} */ (p.connectionDegree ?? '')),
          escapeCsvField(JSON.stringify(p.experiences ?? [])),
          escapeCsvField(/** @type {string} */ (p.company1 ?? '')),
          escapeCsvField(/** @type {string} */ (p.company2 ?? '')),
          escapeCsvField(/** @type {string} */ (p.company3 ?? '')),
        ].join(','),
      );
    }
    await fs.writeFile(csvPath, lines.join('\n'), 'utf8');
    result.csvPath = csvPath;
  }

  return result;
}

/** @param {string} s */
function escapeCsvField(s) {
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
