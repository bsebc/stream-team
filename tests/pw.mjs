// Playwright helpers shared by the test and screenshot scripts.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import fs from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const NM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules');
const LIB = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': NM + '/react/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': NM + '/react-dom/umd/react-dom.production.min.js'
};
const SUPA = NM + '/@supabase/supabase-js/dist/umd/supabase.js';

export async function launch() {
  return chromium.launch();
}

// Opens the app as a given member on a phone-sized viewport with a fixed clock.
export async function openApp(browser, { port = 8787, me = 'roman', lang = 'en', now = '2026-11-01T15:40:00Z', viewport = { width: 390, height: 844 }, hash = '', colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  const page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', e => page.__errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/realtime|websocket|WebSocket|ERR_CONNECTION|404/.test(m.text())) page.__errors.push(m.text()); });
  await page.route('https://unpkg.com/**', r => {
    const f = LIB[r.request().url()];
    return f ? r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f), headers: { 'Access-Control-Allow-Origin': '*' } }) : r.abort();
  });
  await page.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(SUPA), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.clock.install({ time: new Date(now) });
  await fetch(`http://127.0.0.1:${port}/__test/now`, { method: 'POST', body: JSON.stringify({ iso: now }) });
  await page.addInitScript(([me, lang]) => {
    if (!sessionStorage.getItem('__seeded')) {
      localStorage.setItem('streamteam_me', me);
      localStorage.setItem('streamteam_lang', lang);
      sessionStorage.setItem('__seeded', '1');
    }
  }, [me, lang]);
  await page.goto(`http://127.0.0.1:${port}/${hash}`);
  await page.waitForFunction(() => document.body.innerText.length > 50, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  return page;
}

export async function tgMessages(port = 8787, clear = false) {
  const r = await fetch(`http://127.0.0.1:${port}/__test/telegram`, { method: clear ? 'DELETE' : 'GET' });
  return r.json();
}
export async function sql(q, port = 8787) {
  const r = await fetch(`http://127.0.0.1:${port}/__test/sql`, { method: 'POST', body: q });
  return r.json();
}
