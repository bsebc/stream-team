// API tests for the new notify function against the hardened local stack.
// Run after ./reset.sh streamnew new, with the 8788 harness up.
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8788);
let failures = 0, passes = 0;
const ok = (cond, msg, extra) => { if (cond) { passes++; } else { failures++; console.log('FAIL:', msg, extra !== undefined ? JSON.stringify(extra) : ''); } };

async function call(body, ip = '10.0.0.1', key = 'anon-key') {
  const r = await fetch(BASE + '/functions/v1/notify', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key, 'x-forwarded-for': ip }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...j };
}
const sql = async q => (await (await fetch(BASE + '/__test/sql', { method: 'POST', body: q })).json());
const svc = async id => (await sql(`select * from stream.services where id='${id}'`))[0];
const pending = async id => (await sql(`select * from stream.requests where service_id='${id}' and status='pending'`));
const tg = async () => { const m = await (await fetch(BASE + '/__test/telegram')).json(); await fetch(BASE + '/__test/telegram', { method: 'DELETE' }); return m; };
const setNow = iso => fetch(BASE + '/__test/now', { method: 'POST', body: JSON.stringify({ iso }) });
let ipN = 1; const freshIp = () => '10.1.' + (ipN++) + '.1';

await tg();
// Saturday 6:30 PM New York: Sunday Nov 8's reminders are out, so its confirm window is open.
await setNow('2026-11-07T23:30:00Z');

// ---- confirm ----
let r = await call({ action: 'confirm', service_id: '2026-11-08E', member: 'vanya' });
ok(r.error === 'not_yours', 'confirm someone else\'s turn is refused', r);
r = await call({ action: 'confirm', service_id: '2026-11-29E', member: 'roman' });
ok(r.error === 'too_early', 'confirm before the reminder window is refused', r);
r = await call({ action: 'confirm', service_id: '2026-11-08E', member: 'roman' });
ok(r.ok && (await svc('2026-11-08E')).confirmed, 'roman confirms Nov 8 evening', r);
let m = await tg();
ok(m.some(x => /Roman<\/b> confirmed/.test(x.text) && !x.failed), 'group told about confirmation (notify_confirm on)', m);
r = await call({ action: 'confirm', service_id: '2026-11-08E', member: 'roman' });
ok(r.ok && r.already, 'confirming twice is harmless', r);
r = await call({ action: 'confirm', service_id: '2026-11-08E', member: 'nobody' });
ok(r.error === 'who', 'unknown member refused', r);
r = await call({ action: 'confirm', service_id: '2026-11-08E', member: 'viktor' });
ok(r.error === 'inactive', 'inactive member refused', r);

// ---- request cover / cover ----
r = await call({ action: 'request_cover', service_id: '2026-11-29E', member: 'vlad' });
ok(r.error === 'not_yours', 'cannot request cover for someone else\'s turn', r);
r = await call({ action: 'request_cover', service_id: '2026-11-29E', member: 'roman' });
ok(r.ok, 'roman asks for a replacement on Nov 29', r);
let s = await svc('2026-11-29E'); let p = await pending('2026-11-29E');
ok(s.open && p.length === 1 && p[0].from_id === 'roman' && !p[0].to_id, 'service open + one open request', { s, p });
m = await tg();
ok(m.some(x => /Roman<\/b> needs a replacement/.test(x.text)), 'group asked for a replacement', m);
r = await call({ action: 'request_cover', service_id: '2026-11-29E', member: 'roman' });
ok(r.error === 'pending', 'second request on the same turn refused', r);
r = await call({ action: 'ask', service_id: '2026-11-29E', member: 'roman', to: 'vlad' });
ok(r.error === 'pending', 'cannot ask someone while an open request exists', r);
r = await call({ action: 'cover', service_id: '2026-11-29E', member: 'roman' });
ok(r.error === 'already_yours', 'cannot cover your own turn', r);
r = await call({ action: 'cover', service_id: '2026-11-29E', member: 'vlad' });
s = await svc('2026-11-29E'); p = await pending('2026-11-29E');
ok(r.ok && s.member_id === 'vlad' && s.replaced_from === 'roman' && !s.open && !s.confirmed && p.length === 0, 'vlad covers; hand-off recorded; flags reset outside window', { r, s, p });
m = await tg();
ok(m.some(x => /Vlad<\/b> takes .* covering for Roman/.test(x.text)), 'group told vlad covers for roman', m);
r = await call({ action: 'cover', service_id: '2026-11-29E', member: 'nate' });
ok(r.error === 'taken', 'cover of a taken turn refused', r);
r = await call({ action: 'cover', service_id: '2026-11-15E', member: 'nate' });
ok(r.error === 'taken', 'cannot grab a turn nobody released', r);

// cover inside the window counts as confirmed
r = await call({ action: 'request_cover', service_id: '2026-11-08M', member: 'vanya' });
r = await call({ action: 'cover', service_id: '2026-11-08M', member: 'tima' });
s = await svc('2026-11-08M');
ok(r.ok && s.member_id === 'tima' && s.confirmed && s.notified && s.warned, 'taking a turn inside the window auto-confirms', { r, s });
await tg();

// ---- race: two people tap "I'll cover it" at once ----
r = await call({ action: 'request_cover', service_id: '2026-12-06M', member: 'roman' });
const race = await Promise.all([
  call({ action: 'cover', service_id: '2026-12-06M', member: 'vlad' }, freshIp()),
  call({ action: 'cover', service_id: '2026-12-06M', member: 'nate' }, freshIp())
]);
s = await svc('2026-12-06M');
ok(race.filter(x => x.ok).length === 1 && race.filter(x => x.error === 'taken').length === 1 && ['vlad', 'nate'].includes(s.member_id), 'exactly one of two simultaneous covers wins', { race, s });
m = await tg();
ok(m.filter(x => /<\/b> takes /.test(x.text)).length === 1, 'and only one "takes" message is posted', m);

// ---- ask / decline / withdraw / accept ----
r = await call({ action: 'ask', service_id: '2026-11-15E', member: 'vanya', to: 'vanya' });
ok(r.error === 'bad_target', 'cannot ask yourself', r);
r = await call({ action: 'ask', service_id: '2026-11-15E', member: 'vanya', to: 'viktor' });
ok(r.error === 'bad_target', 'cannot ask an inactive member', r);
r = await call({ action: 'ask', service_id: '2026-11-15E', member: 'vanya', to: 'nate' });
p = await pending('2026-11-15E');
ok(r.ok && r.dm === true && p.length === 1 && p[0].to_id === 'nate' && !(await svc('2026-11-15E')).open, 'vanya asks nate directly (service stays closed)', { r, p });
m = await tg();
ok(m.some(x => x.chat === '1000' && /Vanya<\/b> asks you to take/.test(x.text)), 'nate gets a DM', m);
const reqId = p[0].id;
r = await call({ action: 'accept', request_id: reqId, member: 'vlad' });
ok(r.error === 'not_yours', 'someone else cannot accept nate\'s ask', r);
r = await call({ action: 'decline', request_id: reqId, member: 'nate' });
ok(r.ok && (await pending('2026-11-15E')).length === 0, 'nate declines', r);
m = await tg();
ok(m.some(x => x.chat === '1003' && /Nate<\/b> can't take/.test(x.text)), 'vanya told nate declined', m);
r = await call({ action: 'decline', request_id: reqId, member: 'nate' });
ok(r.error === 'answered', 'declining twice -> answered', r);

r = await call({ action: 'ask', service_id: '2026-11-15E', member: 'vanya', to: 'nate' });
r = await call({ action: 'withdraw', service_id: '2026-11-15E', member: 'vlad' });
ok(r.error === 'not_yours', 'a bystander cannot withdraw', r);
r = await call({ action: 'withdraw', service_id: '2026-11-15E', member: 'vanya' });
ok(r.ok && (await pending('2026-11-15E')).length === 0, 'vanya withdraws her ask', r);
m = await tg();
ok(m.some(x => x.chat === '1000' && /withdrew the request/.test(x.text)), 'nate (only) told about withdrawal', m);
ok(!m.some(x => x.chat === '-100'), 'group not told about a private ask', m);

r = await call({ action: 'ask', service_id: '2026-11-15E', member: 'vanya', to: 'nate' });
p = await pending('2026-11-15E');
const both = await Promise.all([
  call({ action: 'accept', request_id: p[0].id, member: 'nate' }, freshIp()),
  call({ action: 'withdraw', service_id: '2026-11-15E', member: 'vanya' }, freshIp())
]);
s = await svc('2026-11-15E');
ok(both.filter(x => x.ok).length === 1, 'accept vs withdraw: exactly one wins', both);
if (both[0].ok) ok(s.member_id === 'nate' && s.replaced_from === 'vanya', 'accept won -> nate holds it', s);
else ok(s.member_id === 'vanya', 'withdraw won -> vanya still holds it', s);
await tg();

// ---- admin PIN + lockout ----
const atk = freshIp();
for (let i = 0; i < 5; i++) { r = await call({ action: 'admin_login', pin: '000' + i }, atk); }
ok(r.error === 'bad pin' && r.status === 401, 'wrong PIN -> bad pin', r);
r = await call({ action: 'admin_login', pin: '1234' }, atk);
ok(r.error === 'locked' && r.status === 429, '6th try from the same address is locked out, even with the right PIN', r);
r = await call({ action: 'admin_login', pin: '1234' }, freshIp());
ok(r.ok && r.settings && r.settings.timezone === 'America/New_York', 'right PIN from another address works', r);
r = await call({ action: 'admin_login' }, freshIp());
ok(r.error === 'bad pin', 'missing PIN refused', r);
r = await call({ action: 'admin_login', pin: ['1234'] }, freshIp());
ok(r.error === 'bad pin', 'non-string PIN refused', r);
const A = (b) => call(Object.assign({ pin: '1234' }, b), '10.9.9.9');

// cancel / restore
await call({ action: 'request_cover', service_id: '2026-12-13E', member: 'vlad' });
await tg();
r = await A({ action: 'admin_cancel_service', id: '2026-12-13E', on: true });
s = await svc('2026-12-13E');
ok(r.ok && s.cancelled && !s.open && (await pending('2026-12-13E')).length === 0, 'admin cancels a service; its open request closes', { r, s });
m = await tg();
ok(m.length === 0, 'no "cancelled" post when schedule updates are off (live setting)', m);
r = await call({ action: 'cover', service_id: '2026-12-13E', member: 'nate' });
ok(r.error === 'cancelled', 'nobody can take a cancelled service', r);
r = await call({ action: 'confirm', service_id: '2026-12-13E', member: 'vlad' });
ok(r.error === 'cancelled' || r.error === 'too_early', 'nor confirm it', r);
r = await A({ action: 'admin_cancel_service', id: '2026-12-13E', on: false });
s = await svc('2026-12-13E');
ok(r.ok && !s.cancelled && !s.notified, 'admin restores it', { r, s });

// leave open -> group asked; member covers an unassigned turn
await tg();
r = await A({ action: 'admin_open_service', id: '2026-12-20M' });
s = await svc('2026-12-20M'); p = await pending('2026-12-20M');
ok(r.ok && !s.member_id && s.open && p.length === 1 && !p[0].from_id, 'admin leaves a turn open', { s, p });
m = await tg();
ok(m.some(x => /No operator<\/b> for/.test(x.text)), 'group told nobody holds it', m);
r = await call({ action: 'cover', service_id: '2026-12-20M', member: 'tima' });
s = await svc('2026-12-20M');
ok(r.ok && s.member_id === 'tima' && s.replaced_from === null && (await pending('2026-12-20M')).length === 0, 'tima takes the unassigned turn (no hand-off recorded)', { r, s });
await tg();

// specials with characters that break Telegram HTML
r = await A({ action: 'admin_add_special', date: '2026-12-24', time: '19:00', label: 'Q&A <night>', member_id: '' });
s = await svc('S2026-12-241900'); p = await pending('S2026-12-241900');
m = await tg();
ok(r.ok && s && s.special === 'Q&A <night>' && s.open && p.length === 1, 'special created open', { r, s, p });
ok(m.length === 1 && !m[0].failed && /Q&amp;A &lt;night&gt;/.test(m[0].text), 'special label is escaped and the post is accepted', m);
r = await A({ action: 'admin_delete_service', id: '2026-12-27M' });
ok(r.error === 'not_special', 'regular services cannot be deleted', r);
r = await A({ action: 'admin_delete_service', id: 'S2026-12-241900' });
ok(r.ok && !(await svc('S2026-12-241900')), 'special deleted', r);
r = await A({ action: 'admin_add_special', date: '2026-12-31', time: '22:00', label: 'New Year', member_id: 'vanya' });
m = await tg();
ok(r.ok && (await svc('S2026-12-312200')).member_id === 'vanya' && m.some(x => /Operator: <b>Vanya/.test(x.text)), 'special assigned to vanya', { r, m });
r = await A({ action: 'admin_add_special', date: '2026-13-40', time: '25:00' });
ok(r.error === 'bad service', 'invalid special date refused', r);

// members
r = await A({ action: 'admin_save_member', member: { id: 'olya', name: 'Olya & Co', name_ru: 'Оля', telegram: 'olya_cam', share_pct: 150, active: true } });
let mem = (await sql(`select * from stream.members where id='olya'`))[0];
ok(r.ok && mem.telegram === '@olya_cam' && mem.share_pct === 100, 'member saved; handle normalised; share clamped', { r, mem });
r = await A({ action: 'admin_save_member', member: { id: 'olya', name: 'Olya', telegram: 'not a handle!' } });
ok(r.error === 'bad telegram', 'bad telegram handle refused', r);
r = await A({ action: 'admin_save_member', member: { id: 'a,b', name: 'x' } });
ok(r.error === 'missing name', 'bad member id refused', r);
// delete a member who has request history (used to fail on the foreign key)
r = await A({ action: 'admin_delete_member', id: 'vanya' });
ok(r.ok && !(await sql(`select 1 from stream.members where id='vanya'`)).length, 'member with request history deleted', r);
ok((await sql(`select count(*)::int n from stream.services where member_id is null and open and date >= '2026-11-08'`))[0].n > 0, 'their upcoming turns opened up', null);

// autofill never touches a cancelled service
await A({ action: 'admin_cancel_service', id: '2027-01-03M', on: true });
r = await A({ action: 'admin_apply_plan', plan: [
  { id: '2027-01-03M', date: '2027-01-03', part: 'M', time: '10:00:00', member_id: 'nate' },
  { id: '2027-01-03E', date: '2027-01-03', part: 'E', time: '18:00:00', member_id: 'nate' }
], total: 2 });
ok(r.ok && r.count === 1 && r.skipped === 1 && (await svc('2027-01-03M')).member_id !== 'nate' && (await svc('2027-01-03E')).member_id === 'nate', 'plan skips the cancelled slot', r);
r = await A({ action: 'admin_apply_plan', plan: [{ id: 'evil', date: '2027-01-03', part: 'M', time: '10:00', member_id: 'nate' }] });
ok(r.error === 'bad plan', 'malformed plan row refused', r);

// settings + PIN
r = await A({ action: 'admin_save_settings', timezone: 'Mars/Olympus' });
ok(r.error === 'bad timezone', 'invalid zone refused', r);
r = await A({ action: 'admin_save_settings', rem_hours: 500, warn_hours: 3 });
let st = (await sql(`select rem_hours, warn_hours from stream.settings`))[0];
ok(r.ok && st.rem_hours === 72 && st.warn_hours === 3, 'settings saved and clamped', { r, st });
await A({ action: 'admin_save_settings', rem_hours: 24, warn_hours: 2 });
r = await A({ action: 'admin_change_pin', new_pin: '9999' });
ok(r.error === 'pin too short', 'PIN under 6 refused', r);
r = await A({ action: 'admin_change_pin', new_pin: '246810' });
ok(r.ok, 'PIN changed', r);
r = await call({ action: 'admin_login', pin: '1234' }, freshIp());
ok(r.error === 'bad pin', 'old PIN no longer works', r);
r = await call({ action: 'admin_login', pin: '246810' }, freshIp());
ok(r.ok, 'new PIN works', r);
await sql(`update stream.settings set admin_pin='1234'`);

// admin withdraw of a request that is not theirs
await call({ action: 'request_cover', service_id: '2027-01-10E', member: 'tima' });
r = await call({ action: 'withdraw', service_id: '2027-01-10E', pin: '1234' }, '10.9.9.9');
ok(r.ok && !(await svc('2027-01-10E')).open, 'admin withdraws someone\'s request', r);
r = await call({ action: 'withdraw', service_id: '2027-01-10E', pin: 'nope' }, freshIp());
ok(r.error === 'bad pin', 'admin withdraw needs the right PIN', r);
await tg();

// ---- reminders (cron) ----
await sql(`update stream.services set notified=false, warned=false, confirmed=false where id in ('2026-11-08E','2026-11-08M')`);
await sql(`update stream.services set member_id='viktor' where id='2026-11-08M'`);   // inactive holder
await setNow('2026-11-07T23:05:00Z');
r = await call({}, '10.200.0.1', 'service-key');
m = await tg();
ok(r.ok !== false && m.some(x => x.chat === '-100' && /Coming up<\/b> — Evening 6 PM, Sun, Nov 8/.test(x.text) && /Operator: <b>Roman/.test(x.text)), 'evening reminder posted with the right local time', m);
ok(m.some(x => x.chat === '1001' && /You are on the livestream/.test(x.text) && /&amp;me=roman/.test(x.text)), 'roman gets the DM with a deep link', m);
ok(m.some(x => x.chat === '-100' && /No operator<\/b> for Morning 10 AM/.test(x.text)) && !m.some(x => /Viktor/.test(x.text)), 'turn held by an inactive member is announced as needing an operator', m);
r = await call({}, '10.200.0.1', 'service-key');
m = await tg();
ok(!m.some(x => /Coming up|No operator/.test(x.text)), 'second tick sends nothing new', m);
// last call: 1h before evening start and still unconfirmed
await setNow('2026-11-08T22:00:00Z');
r = await call({}, '10.200.0.1', 'service-key');
m = await tg();
ok(m.some(x => x.chat === '-100' && /Not confirmed yet<\/b> — Evening 6 PM starts in 1h/.test(x.text)), 'last-call warning posted', m);

// ---- abuse ----
r = await call({ event: 'cover_requested', service_id: '2026-11-29E', from: 'roman' });
ok(r.status === 410, 'old unauthenticated events are gone', r);
const flood = freshIp();
let last; for (let i = 0; i < 62; i++) last = await call({ action: 'confirm', service_id: '2026-11-29E', member: 'roman' }, flood);
ok(last.error === 'busy' && last.status === 429, 'one address flooding actions is slowed down', last);
const tick = freshIp();
for (let i = 0; i < 7; i++) last = await call({}, tick);
ok(last.error === 'busy', 'non-cron reminder ticks are rate limited', last);
r = await call({ action: 'admin_nuke' }, freshIp());
ok(r.error === 'bad pin', 'unknown admin action still needs the PIN', r);


// ---- audit follow-ups ----
await setNow('2026-11-07T23:30:00Z');
const A2 = (b) => call(Object.assign({ pin: '1234' }, b), '10.9.9.8');
// withdraw vs cover on an open call: exactly one wins, and no contradictory posts
await call({ action: 'request_cover', service_id: '2027-02-07E', member: 'vlad' });
await tg();
const wc = await Promise.all([
  call({ action: 'withdraw', service_id: '2027-02-07E', member: 'vlad' }, freshIp()),
  call({ action: 'cover', service_id: '2027-02-07E', member: 'nate' }, freshIp())
]);
s = await svc('2027-02-07E'); m = await tg();
ok(wc.filter(x => x.ok).length === 1, 'withdraw vs cover: exactly one wins', wc);
ok(!(m.some(x => /no longer needs cover/.test(x.text)) && m.some(x => /<\/b> takes /.test(x.text))), 'never both "no longer needs cover" and "takes it"', m);
ok(!s.open && (await pending('2027-02-07E')).length === 0, 'no request left dangling', { s });

// cover reports whether it counted as confirmed
await call({ action: 'request_cover', service_id: '2026-11-08E', member: 'roman' });
r = await call({ action: 'cover', service_id: '2026-11-08E', member: 'vlad' });
ok(r.ok && r.confirmed === true, 'cover inside the window says it is confirmed', r);
r = await call({ action: 'request_cover', service_id: '2027-02-14E', member: 'vlad' });
ok(r.ok && r.told === true, 'request_cover reports the group was told', r);

// settings order, special clash, new member ids
r = await A2({ action: 'admin_save_settings', rem_hours: 2, warn_hours: 2 });
ok(r.error === 'warn_order', 'warning at/after the reminder refused', r);
r = await A2({ action: 'admin_add_special', date: '2027-03-01', time: '19:00', label: 'Prayer' });
r = await A2({ action: 'admin_add_special', date: '2027-03-01', time: '19:00', label: 'Other' });
ok(r.error === 'exists', 'a second special at the same moment is refused', r);
r = await A2({ action: 'admin_save_member', member: { create: true, name: 'Nate', telegram: '' } });
ok(r.ok && r.id === 'nate2' && (await sql(`select name from stream.members where id='nate'`))[0].name === 'Nate', 'adding a namesake gets a new id and leaves the original alone', r);

// autofill clears requests on the slots it fills
await call({ action: 'request_cover', service_id: '2027-02-21M', member: 'roman' });
r = await A2({ action: 'admin_apply_plan', plan: [{ id: '2027-02-21M', date: '2027-02-21', part: 'M', time: '10:00:00', member_id: 'vlad' }], total: 1, silent: true });
ok(r.ok && (await pending('2027-02-21M')).length === 0 && !(await svc('2027-02-21M')).open, 'auto-fill closes the old request on a slot it fills', r);

// reminders: two overlapping runs post once; open + unassigned wording
await sql(`update stream.services set notified=false, warned=false, confirmed=false, open=false, member_id='roman' where id='2026-11-15E'`);
await sql(`update stream.services set notified=false, warned=false, confirmed=false, open=true, member_id='vlad' where id='2026-11-15M'`);
await setNow('2026-11-14T23:05:00Z');
await tg();
await Promise.all([call({}, '10.200.0.2', 'service-key'), call({}, '10.200.0.3', 'service-key'), call({}, '10.200.0.4', 'service-key')]);
m = await tg();
ok(m.filter(x => /Coming up<\/b> — Evening 6 PM, Sun, Nov 15/.test(x.text)).length === 1, 'three overlapping runs post the reminder once', m);
ok(m.filter(x => /Vlad<\/b> still needs a replacement — Morning 10 AM/.test(x.text)).length === 1, 'an open turn is announced as still needing a replacement', m);
ok(!m.some(x => x.chat === '1005'), 'and its holder is not DMed "you are on"', m);
await setNow('2026-11-15T14:00:00Z');
await call({}, '10.200.0.5', 'service-key');
m = await tg();
ok(m.some(x => /Still no operator<\/b> — Morning 10 AM starts in 1h/.test(x.text)), 'last call for a turn still needing cover', m);
await sql(`update stream.settings set rem_hours=24, warn_hours=2`);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
