// End-to-end: drive the new UI through every core flow on the local stack
// (port 8788, hardened DB, new function) and check DB + Telegram after each.
import { launch, openApp } from './pw.mjs';
const PORT = +(process.env.PORT || 8788), BASE = 'http://127.0.0.1:' + PORT;
let passes = 0, failures = 0;
const ok = (c, msg, extra) => { if (c) passes++; else { failures++; console.log('FAIL:', msg, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); } };
const sql = async q => (await (await fetch(BASE + '/__test/sql', { method: 'POST', body: q })).json());
const svc = async id => (await sql(`select * from stream.services where id='${id}'`))[0];
const pending = async id => await sql(`select * from stream.requests where service_id='${id}' and status='pending'`);
const tg = async () => { const m = await (await fetch(BASE + '/__test/telegram')).json(); await fetch(BASE + '/__test/telegram', { method: 'DELETE' }); return m; };
const toastText = async p => { const t = p.locator('.toast'); await t.waitFor({ timeout: 8000 }); return (await t.innerText()).trim(); };
const waitToastGone = async p => { await p.locator('.toast').waitFor({ state: 'detached', timeout: 9000 }).catch(() => {}); };
const tab = async (p, name) => { await p.locator('.tab', { hasText: name }).click(); await p.waitForTimeout(300); };
const sheetGone = async p => { await p.locator('.scrim').waitFor({ state: 'detached', timeout: 5000 }); };

const b = await launch();
const NOW = '2026-11-07T23:30:00Z';   // Sat 6:30 PM NY: Sun Nov 8 reminders are out
await tg();

// ---------- 1. confirm from the pass ----------
let p = await openApp(b, { port: PORT, me: 'roman', now: NOW });
let pass = p.locator('.pass');
ok(/Ready to confirm/.test(await pass.innerText()), 'pass says ready to confirm', await pass.innerText());
await pass.getByRole('button', { name: 'Confirm' }).click();
let t = await toastText(p);
ok(/Confirmed/.test(t), 'toast after confirm', t);
ok((await svc('2026-11-08E')).confirmed, 'DB: Nov 8 evening confirmed');
await p.waitForTimeout(400);
ok(/Confirmed/.test(await pass.innerText()) && await pass.locator('.lamp[data-s="ready"]').count() === 1, 'lamp turns green');
let m = await tg();
ok(m.some(x => /Roman<\/b> confirmed/.test(x.text)), 'group told', m);

// ---------- 2. request replacement via the sheet ----------
await pass.getByRole('button', { name: 'Request replacement' }).click();
await p.locator('.sheet').waitFor();
ok(await p.locator('.sheet .statusline').innerText().then(x => /Confirmed/.test(x)), 'sheet shows status');
await waitToastGone(p);
await p.locator('.sheet').getByRole('button', { name: 'Request replacement' }).click();
t = await toastText(p);
ok(/Replacement requested/.test(t), 'toast after request', t);
await sheetGone(p);
let s = await svc('2026-11-08E');
ok(s.open && (await pending('2026-11-08E')).length === 1, 'DB: open + request', s);
m = await tg();
ok(m.some(x => /Roman<\/b> needs a replacement/.test(x.text)), 'group asked', m);
await p.waitForTimeout(300);
ok(/Looking for a replacement/.test(await pass.innerText()), 'pass shows looking for a replacement', await pass.innerText());

// ---------- 3. someone else covers it from Schedule ----------
let v = await openApp(b, { port: PORT, me: 'vlad', now: NOW });
await tab(v, 'Schedule');
const card = v.locator('.req', { hasText: 'Roman needs a replacement' });
ok(await card.count() === 1, 'open request card on Schedule');
await card.getByRole('button', { name: "I'll cover it" }).click();
await v.locator('.sheet').waitFor();
ok(/covering for Roman/i.test(await v.locator('.sheet').innerText()), 'cover sheet explains who for', await v.locator('.sheet').innerText());
await v.locator('.sheet').getByRole('button', { name: "I'll cover it" }).click();
t = await toastText(v);
ok(/It’s yours — counted as confirmed/.test(t), 'toast: yours, auto-confirmed (inside window)', t);
s = await svc('2026-11-08E');
ok(s.member_id === 'vlad' && s.replaced_from === 'roman' && s.confirmed && !s.open, 'DB: vlad holds it, hand-off recorded', s);
m = await tg();
ok(m.some(x => /Vlad<\/b> takes .* covering for Roman/.test(x.text)), 'group told vlad takes it', m);
// Roman's phone catches up (poll/realtime replaced by a reload here)
await p.reload(); await p.waitForTimeout(900);
ok(!(await p.locator('.pass').innerText()).includes('Nov 8') && /29|Sunday|November/.test(await p.locator('.pass').innerText()), 'roman\'s pass moves to his next turn');
await v.context().close();

// ---------- 4. ask someone directly; they decline; ask again; they accept ----------
// Roman's next turn is Nov 29 evening
await p.locator('.pass').getByRole('button', { name: 'Request replacement' }).click();
await p.locator('.sheet').waitFor();
await p.locator('.sheet .chip', { hasText: 'Nate' }).click();
await p.locator('.sheet').getByRole('button', { name: 'Ask Nate' }).click();
t = await toastText(p);
ok(/Asked Nate/.test(t), 'toast after ask', t);
let r = await pending('2026-11-29E');
ok(r.length === 1 && r[0].to_id === 'nate', 'DB: direct request to nate', r);
m = await tg();
ok(m.some(x => x.chat === '1000' && /Roman<\/b> asks you to take/.test(x.text)), 'nate DMed', m);

let n = await openApp(b, { port: PORT, me: 'nate', now: NOW });
let ask = n.locator('.req', { hasText: 'Roman asks you to take this' });
ok(await ask.count() === 1, 'nate sees the ask on My turns');
await ask.getByRole('button', { name: 'Decline' }).click();
t = await toastText(n);
ok(/Declined/.test(t), 'decline toast', t);
ok((await pending('2026-11-29E')).length === 0, 'DB: ask closed');
m = await tg();
ok(m.some(x => x.chat === '1001' && /Nate<\/b> can't take/.test(x.text)), 'roman told nate declined', m);

await p.reload(); await p.waitForTimeout(900);
await p.locator('.pass').getByRole('button', { name: 'Request replacement' }).click();
await p.locator('.sheet .chip', { hasText: 'Nate' }).click();
await p.locator('.sheet').getByRole('button', { name: 'Ask Nate' }).click();
await toastText(p);
await waitToastGone(p);
await n.reload(); await n.waitForTimeout(900);
await n.locator('.req', { hasText: 'Roman asks you to take this' }).getByRole('button', { name: 'Accept' }).click();
t = await toastText(n);
ok(/It’s yours/.test(t), 'accept toast', t);
s = await svc('2026-11-29E');
ok(s.member_id === 'nate' && s.replaced_from === 'roman', 'DB: nate holds Nov 29', s);
await tg();

// ---------- 5. withdraw an ask ----------
await p.reload(); await p.waitForTimeout(900);
await p.locator('.pass').getByRole('button', { name: 'Request replacement' }).click();
await p.locator('.sheet .chip', { hasText: 'Vanya' }).click();
await p.locator('.sheet').getByRole('button', { name: 'Ask Vanya' }).click();
await toastText(p); await waitToastGone(p);
await p.locator('.req', { hasText: 'You asked Vanya' }).getByRole('button', { name: 'Withdraw' }).click();
t = await toastText(p);
ok(/withdrawn/i.test(t), 'withdraw toast', t);
const dec6 = (await sql(`select id from stream.services where member_id='roman' and date > '2026-11-29' order by date limit 1`))[0].id;
ok((await pending(dec6)).length === 0, 'DB: ask withdrawn');
m = await tg();
ok(m.some(x => x.chat === '1003' && /withdrew the request/.test(x.text)), 'vanya told', m);
await n.context().close();

// ---------- 6. the race loser sees a clear message ----------
await sql(`update stream.services set open = true where id = '2026-12-13E'`);
await sql(`insert into stream.requests (service_id, from_id, status) values ('2026-12-13E', 'vlad', 'pending')`);
const a1 = await openApp(b, { port: PORT, me: 'nate', now: NOW });
const a2 = await openApp(b, { port: PORT, me: 'tima', now: NOW });
for (const x of [a1, a2]) { await tab(x, 'Schedule'); await x.locator('.req', { hasText: 'Vlad needs a replacement' }).getByRole('button', { name: "I'll cover it" }).click(); await x.locator('.sheet').waitFor(); }
await a1.locator('.sheet').getByRole('button', { name: "I'll cover it" }).click();
await toastText(a1);
await a2.locator('.sheet').getByRole('button', { name: "I'll cover it" }).click();
t = await toastText(a2);
ok(/Someone else just took it/.test(t), 'second taker told it was taken', t);
await a1.context().close(); await a2.context().close();
await tg();

// ---------- 7. who-picker + deep links ----------
const w = await openApp(b, { port: PORT, me: '', now: NOW });
ok(/Choose your name/.test(await w.locator('.view').innerText()), 'no name yet -> prompt');
await w.click('.me'); await w.locator('.sheet').waitFor();
await w.locator('.sheet .row', { hasText: 'Tim' }).click();
await sheetGone(w);
ok((await w.locator('.me').innerText()).includes('Tim'), 'picked Tim');
await w.keyboard.press('Escape');
await w.context().close();
// fresh device opening a reminder link
const dl = await openApp(b, { port: PORT, me: '', now: NOW, hash: '#t=2026-11-15E&amp;me=vanya' });
await dl.waitForTimeout(600);
ok((await dl.locator('.me').innerText()).includes('Vanya') && await dl.locator('.sheet').count() === 1, 'deep link on a fresh phone: picks Vanya and opens the turn');
await dl.keyboard.press('Escape'); await dl.waitForTimeout(400);
ok(await dl.locator('.sheet').count() === 0, 'Escape closes the sheet');
await dl.context().close();
// someone else's phone opening a forwarded link
const fw = await openApp(b, { port: PORT, me: 'vlad', now: NOW, hash: '#t=2026-11-15E&me=vanya' });
await fw.waitForTimeout(900);
ok((await fw.locator('.me').innerText()).includes('Vlad') && /That link was for Vanya/.test(await fw.locator('.toast').innerText().catch(() => '')), 'forwarded link does not switch identity');
await fw.context().close();

// ---------- 8. calendar file ----------
const href = await p.locator('a[download]').getAttribute('href');
const ics = decodeURIComponent(href.split(',')[1]);
ok(/BEGIN:VCALENDAR/.test(ics) && /DTSTAMP:\d{8}T\d{6}Z/.test(ics) && /DTSTART:\d{8}T\d{6}Z/.test(ics), 'calendar file has UTC times and DTSTAMP', ics.slice(0, 300));
await p.context().close();

// ---------- 9. admin ----------
const ad = await openApp(b, { port: PORT, me: 'roman', now: NOW });
await tab(ad, 'Admin');
await ad.fill('input[type=password]', '0000'); await ad.click('button[type=submit]');
await ad.locator('.err').waitFor();
ok(/Wrong PIN/.test(await ad.locator('.err').innerText()), 'wrong PIN message');
await ad.fill('input[type=password]', '1234'); await ad.click('button[type=submit]');
await ad.locator('text=Planning').waitFor();
ok(true, 'signed in');
// assign from the schedule
await tab(ad, 'Schedule');
await ad.locator('.day', { hasText: '22' }).first().locator('.cell').first().click();
await ad.locator('.sheet').waitFor();
await ad.locator('.sheet .picker .row', { hasText: 'Nate' }).click();
t = await toastText(ad);
ok(/Assigned to Nate/.test(t) && (await svc('2026-11-22M')).member_id === 'nate', 'admin assigns Nov 22 morning to Nate', t);
await waitToastGone(ad);
// cancel needs two taps, then restore
await ad.locator('.day', { hasText: '22' }).first().locator('.cell').first().click();
await ad.locator('.sheet').waitFor();
await ad.locator('.sheet').getByRole('button', { name: 'Cancel this service' }).click();
ok(await ad.locator('.sheet').getByRole('button', { name: 'Tap again to confirm' }).count() === 1, 'cancel asks for a second tap');
ok(!(await svc('2026-11-22M')).cancelled, 'not cancelled after one tap');
await ad.locator('.sheet').getByRole('button', { name: 'Tap again to confirm' }).click();
t = await toastText(ad);
ok(/Service cancelled/.test(t) && (await svc('2026-11-22M')).cancelled, 'cancelled after second tap', t);
await waitToastGone(ad);
await ad.waitForTimeout(500);
ok(/Cancelled/.test(await ad.locator('.day', { hasText: '22' }).first().innerText()), 'schedule shows it cancelled');
await ad.locator('.day', { hasText: '22' }).first().locator('.cell').first().click();
await ad.locator('.sheet').getByRole('button', { name: 'Put this service back on' }).click();
t = await toastText(ad);
ok(/back on/.test(t) && !(await svc('2026-11-22M')).cancelled, 'restored', t);
await waitToastGone(ad);
// leave open
await ad.locator('.day', { hasText: '22' }).first().locator('.cell').nth(1).click();
await ad.locator('.sheet .picker .row', { hasText: 'ask the group' }).click();
t = await toastText(ad);
s = await svc('2026-11-22E');
ok(/group has been asked/.test(t) && !s.member_id && s.open && (await pending('2026-11-22E')).length === 1, 'left open for the group', { t, s });
await waitToastGone(ad);
m = await tg();
ok(m.some(x => /No operator<\/b> for/.test(x.text)), 'group asked for an operator', m);
// special service
await tab(ad, 'Admin');
await ad.locator('button.row', { hasText: 'Special service' }).click();
await ad.locator('.sheet').waitFor();
await ad.locator('.sheet input[type=text]').fill('Christmas Eve');
await ad.locator('.sheet input[type=date]').fill('2026-12-24');
await ad.locator('.sheet input[type=time]').fill('19:00');
await ad.locator('.sheet').getByRole('button', { name: 'Add service' }).click();
t = await toastText(ad);
ok(/Special service added/.test(t) && (await svc('S2026-12-241900')), 'special added', t);
await waitToastGone(ad);
// member add + edit
await ad.locator('.sec', { hasText: 'Team' }).getByRole('button', { name: 'Add' }).click();
await ad.locator('.sheet').waitFor();
const ins = ad.locator('.sheet input');
await ins.nth(0).fill('Olya'); await ins.nth(1).fill('Оля'); await ins.nth(2).fill('@olya_cam'); await ins.nth(3).fill('5');
await ad.locator('.sheet').getByRole('button', { name: 'Save' }).click();
t = await toastText(ad);
const olya = (await sql(`select * from stream.members where name='Olya'`))[0];
ok(/Saved/.test(t) && olya && olya.id === 'olya' && olya.telegram === '@olya_cam' && olya.share_pct === 5, 'member added', olya);
await waitToastGone(ad);
await ad.locator('button.row', { hasText: 'Olya' }).click();
await ad.locator('.sheet .switch').click();
await ad.locator('.sheet').getByRole('button', { name: 'Save' }).click();
await toastText(ad);
ok((await sql(`select active from stream.members where id='olya'`))[0].active === false, 'member switched off');
await waitToastGone(ad);
// notification toggle (optimistic) + stepper
const before = (await sql(`select notify_schedule from stream.settings`))[0].notify_schedule;
await ad.locator('.row', { hasText: 'Schedule changes' }).locator('.switch').click();
await ad.waitForTimeout(900);
ok((await sql(`select notify_schedule from stream.settings`))[0].notify_schedule === !before, 'toggle saved');
await ad.locator('.row', { hasText: 'Reminder' }).getByRole('button', { name: '+' }).click();
await ad.locator('.row', { hasText: 'Reminder' }).getByRole('button', { name: '+' }).click();
await ad.waitForTimeout(1600);
ok((await sql(`select rem_hours from stream.settings`))[0].rem_hours === 26, 'stepper saved once after taps');
await ad.locator('.row', { hasText: 'Reminder' }).getByRole('button', { name: '−' }).click();
await ad.locator('.row', { hasText: 'Reminder' }).getByRole('button', { name: '−' }).click();
await ad.waitForTimeout(1600);
// test message
await waitToastGone(ad);
await ad.getByRole('button', { name: 'Send a test message' }).click();
t = await toastText(ad);
ok(/Test message sent/.test(t), 'test message', t);
await waitToastGone(ad);
// auto-fill: preview + apply
await ad.locator('button.row', { hasText: 'Auto-fill' }).click();
await ad.locator('.sheet').waitFor();
await ad.locator('.sheet input[type=date]').nth(0).fill('2027-01-01');
await ad.locator('.sheet input[type=date]').nth(1).fill('2027-02-28');
await ad.locator('.sheet .switch').click();     // replace existing
await ad.locator('.sheet').getByRole('button', { name: 'Preview' }).click();
await ad.locator('.sheet .preview').waitFor();
const prevRows = await ad.locator('.sheet .preview > div').count();
ok(prevRows >= 10, 'preview lists the plan', prevRows);
await ad.locator('.sheet').getByRole('button', { name: /Apply/ }).click();
t = await toastText(ad);
ok(/services assigned/.test(t), 'auto-fill applied', t);
m = await tg();
ok(m.filter(x => /Schedule updated/.test(x.text)).length <= 1, 'one schedule post at most', m);
await waitToastGone(ad);
// change PIN (6+), sign out, sign back in with it
await ad.locator('button.row', { hasText: 'Change PIN' }).click();
await ad.locator('.sheet input').fill('12345');
ok(await ad.locator('.sheet').getByRole('button', { name: 'Save' }).isDisabled(), 'save disabled under 6 digits');
await ad.locator('.sheet input').fill('135790');
await ad.locator('.sheet').getByRole('button', { name: 'Save' }).click();
t = await toastText(ad);
ok(/PIN changed/.test(t), 'pin changed', t);
await ad.locator('button.row', { hasText: 'Sign out' }).click();
await tab(ad, 'Admin');
await ad.fill('input[type=password]', '135790'); await ad.click('button[type=submit]');
await ad.locator('text=Planning').waitFor();
ok(true, 'signed in with the new PIN');
await sql(`update stream.settings set admin_pin='1234'`);
ok(ad.__errors.filter(e => !/401/.test(e)).length === 0, 'no page errors during admin run (the deliberate wrong PIN is a 401)', ad.__errors);
await ad.context().close();

// ---------- 10. Russian + desktop render without errors ----------
const ru = await openApp(b, { port: PORT, me: 'vanya', lang: 'ru', now: NOW });
for (const name of ['Расписание', 'Статистика', 'Админ', 'Мои смены']) await tab(ru, name);
ok(ru.__errors.length === 0, 'RU tabs render cleanly', ru.__errors);
await ru.context().close();
const dk = await openApp(b, { port: PORT, me: 'vanya', now: NOW, viewport: { width: 1280, height: 800 } });
for (const name of ['Schedule', 'Stats', 'Admin', 'My turns']) { await dk.locator('.tabs-top button', { hasText: name }).click(); await dk.waitForTimeout(250); }
ok(dk.__errors.length === 0, 'desktop tabs render cleanly', dk.__errors);
await dk.context().close();

await b.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
