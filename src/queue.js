class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      if (this.count < this.max) {
        this.count++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.count--;
    }
  }

  async wrap(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// Per-domain rate limiter: enforces at least 1000ms between requests to the same domain
const domainLastRequest = new Map();
const userLastRequest = new Map();

async function domainRateLimit(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return;
  }

  const now = Date.now();
  const last = domainLastRequest.get(hostname) || 0;
  const wait = 1000 - (now - last);

  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }

  domainLastRequest.set(hostname, Date.now());
}

async function userRateLimit(userId, minGapMs = 250) {
  if (!userId) return;
  const key = String(userId);
  const now = Date.now();
  const last = userLastRequest.get(key) || 0;
  const wait = minGapMs - (now - last);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  userLastRequest.set(key, Date.now());
}

// Global semaphore: max 5 concurrent URL checks
const checkSemaphore = new Semaphore(5);

module.exports = { Semaphore, domainRateLimit, userRateLimit, checkSemaphore };
