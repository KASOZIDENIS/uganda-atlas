// Reviewers only: who is winning each project, from the points awarded so far.
//   node scripts/winners.mjs            (top 5 per project)
//   node scripts/winners.mjs 10         (top 10 per project)
// Reverted/undone edits are not counted; deleted work does not appear in the Wikimedia contribution lists.
// Prints to the screen only. Nothing is written or published.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBoard, buildContext, getParticipants, SMALL_LISTS } from '../editathon/board.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = p => JSON.parse(readFileSync(join(root, p), 'utf-8'));
const config = rd('editathon/config.json');
let manual = [];
try { manual = rd('editathon/participants.json').participants || []; } catch (e) { /* ignore */ }
const index = rd('editathon/tasks/index.json');
const loaded = {};
for (const l of index.lists) if (SMALL_LISTS.includes(l.id)) {
  loaded[l.id] = [];
  for (let n = 0; n < l.chunks; n++) loaded[l.id].push(...rd(`editathon/tasks/${l.id}.${n}.json`));
}
const ctx = buildContext(index, loaded);
const ua = { 'User-Agent': 'UgandaAtlasEditathon/1.0 (https://kasozidenis.github.io/uganda-atlas/; wikimedia community user group uganda)' };
const fetchFn = url => fetch(url, { headers: ua });
const { users } = await getParticipants(config, fetchFn, manual);
const board = await computeBoard({ config, users, ctx, fetchFn, verify: true });
const top = Math.max(1, parseInt(process.argv[2], 10) || 5);

console.log(`${config.name}: ${board.state}, ${board.totals.participants} participants, generated ${board.generated}\n`);
const dropped = board.dropped || [];
console.log(`Checked every counted edit: ${dropped.length} no longer live (${dropped.filter(d => d.why === 'deleted').length} deleted, ${dropped.filter(d => d.why === 'reverted').length} undone/reverted), ${dropped.reduce((s, d) => s + d.points, 0)} points removed.\n`);
for (const p of Object.values(board.projects)) {
  console.log(`== ${p.label}${p.prize ? '  (prize ' + p.prize.toLocaleString() + ')' : ''}`);
  if (!p.ranking.length) { console.log('   no points yet\n'); continue; }
  for (const r of p.ranking.slice(0, top)) console.log(`   ${String(r.rank).padStart(2)}. ${r.user.padEnd(28)} ${String(r.points).padStart(5)} pts  ${String(r.edits).padStart(4)} edits${r.rank === 1 ? '   <- leading' : ''}`);
  console.log('');
}
if (process.argv.includes('--dropped')) for (const d of dropped) console.log(`dropped (${d.why}) ${d.user} ${d.wiki} ${d.title} rev ${d.revid} -${d.points}`);
if (board.errors.length) console.log('\nErrors:\n' + board.errors.join('\n'));
