function ts() {
  return new Date().toISOString();
}

export function info(msg, meta) {
  if (meta !== undefined) {
    console.log(`[${ts()}] [INFO]`, msg, meta);
  } else {
    console.log(`[${ts()}] [INFO]`, msg);
  }
}

export function warn(msg, meta) {
  if (meta !== undefined) {
    console.warn(`[${ts()}] [WARN]`, msg, meta);
  } else {
    console.warn(`[${ts()}] [WARN]`, msg);
  }
}

export function error(msg, meta) {
  if (meta !== undefined) {
    console.error(`[${ts()}] [ERROR]`, msg, meta);
  } else {
    console.error(`[${ts()}] [ERROR]`, msg);
  }
}

/**
 * @param {number} count
 * @param {number} every
 * @param {string} [context]
 */
export function progressEvery(count, every, context = '') {
  if (count > 0 && count % every === 0) {
    const suffix = context ? ` ${context}` : '';
    info(`Progress: ${count} unique people collected.${suffix}`);
  }
}
