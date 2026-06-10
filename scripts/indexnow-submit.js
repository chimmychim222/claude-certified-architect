/**
 * Pings the IndexNow API (used by Bing, Yandex, and other participating
 * search engines) with every URL in sitemap.xml, so they know to re-crawl
 * the site without waiting for their normal crawl schedule.
 *
 * Run after `node build.js` regenerates sitemap.xml, or standalone any time
 * you want to nudge re-crawling (e.g. after publishing a new blog post).
 *
 * Usage:
 *   node scripts/indexnow-submit.js
 */

const fs = require('fs');
const path = require('path');

const HOST = 'www.claudecertifiedarchitects.com';
// Current IndexNow API key — must stay reachable at
// https://<HOST>/<KEY>.txt returning the key as plain text (verified live
// 2026-06-10). See 97d4e72d3b864aa18da7a124ec41e7e4.txt at the site root;
// added in commit 69956d0 ("Add IndexNow key file for Bing Webmaster Tools
// (new key)"). If the key is ever rotated, update both the key file and
// this constant.
const KEY = '97d4e72d3b864aa18da7a124ec41e7e4';

const sitemapPath = path.join(__dirname, '..', 'sitemap.xml');
const xml = fs.readFileSync(sitemapPath, 'utf8');
const urlList = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);

if (!urlList.length) {
  console.error('No URLs found in sitemap.xml — aborting.');
  process.exit(1);
}

(async () => {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: HOST,
      key: KEY,
      keyLocation: `https://${HOST}/${KEY}.txt`,
      urlList,
    }),
  });

  const body = await res.text();
  // 200 = accepted, 202 = accepted (key validation pending) — both are success.
  const ok = res.status === 200 || res.status === 202;
  console.log(`IndexNow: submitted ${urlList.length} URLs from sitemap.xml — HTTP ${res.status}${body ? ' ' + body : ''}`);

  if (!ok) {
    console.error('IndexNow submission was not accepted.');
    process.exit(1);
  }
})();
