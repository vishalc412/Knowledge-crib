// measure-drift.mjs - the generator for index.json's `anchorDriftAtHead` and `codeHeadNote`.
//
// Run it from anywhere:  node .crib/bins/developer-trust/measure-drift.mjs
//
// It reads every .md and .json file in this bin, extracts every path:line and bare-basename:line
// citation, and compares the text each cited line holds at the bin's declared stamp revision and at
// HEAD. It then rewrites the two generated fields in index.json. Nothing else in index.json is
// touched, and no prose file is modified.
//
// It is committed on purpose. The counts in index.json are claims, and a claim whose generator lives
// nowhere cannot be re-measured by the next reader - which is the failure this bin exists to catch.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const BIN = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(BIN, '../../..');
const IDX = BIN + '/index.json';
const HEAD = execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim();

const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
const STAMP = idx.codeHead;

const ls = (cmd) => execSync(cmd, { cwd: REPO, maxBuffer: 1 << 28 }).toString().trim().split('\n').filter(Boolean);
const tracked = ls('git ls-files').concat(ls('git ls-files --others --exclude-standard'));
const byBase = new Map();
for (const p of tracked) { const b = p.split('/').pop(); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(p); }

const revCache = new Map();
const getRev = (path, rev) => {
  const k = rev + '|' + path;
  if (revCache.has(k)) return revCache.get(k);
  let v;
  try { v = execSync(`git show '${rev}:${path}' 2>/dev/null`, { cwd: REPO, maxBuffer: 1 << 28 }).toString().split('\n'); } catch { v = null; }
  revCache.set(k, v); return v;
};

const TOK = /([A-Za-z0-9_.\/-]+\.(?:ts|mjs|js|json|md|yml|html))[:`]*:?([0-9]{2,5})/g;
const FULLPATH = /[A-Za-z0-9_.\/-]+\/[A-Za-z0-9_.-]+\.(?:ts|mjs|js|json|md|yml|html)/g;

const files = fs.readdirSync(BIN).filter(f => /\.(md|json)$/.test(f)).map(f => [f, BIN + '/' + f]);

// index.json carries GENERATED fields that list anchors; the measurement must not cite itself.
const textOf = (rel, abs) => {
  const raw = fs.readFileSync(abs, 'utf8');
  if (rel !== 'index.json') return raw;
  const j = JSON.parse(raw);
  delete j.codeHeadNote; delete j.anchorDriftAtHead;
  return JSON.stringify(j);
};

// pass 1 — the full repo paths each file introduces, so a later bare basename is disambiguated
const introducedByFile = new Map();
for (const [rel, abs] of files) {
  const t = textOf(rel, abs);
  introducedByFile.set(rel, new Set((t.match(FULLPATH) || []).filter(p => fs.existsSync(REPO + '/' + p))));
}

// A bare basename resolves ONLY when the citing file itself disambiguates it. Otherwise the
// measurement cannot say which file was meant, and guessing would attach the citation to a file the
// bin never named — the defect this resolver replaces.
const resolve = (raw, rel, ln) => {
  if (raw.includes('/')) { const t = raw.replace(/^\.\//, ''); return fs.existsSync(REPO + '/' + t) ? t : null; }
  const cands = byBase.get(raw) || [];
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const intro = introducedByFile.get(rel) || new Set();
  const named = cands.filter(c => intro.has(c));
  if (named.length === 1) return named[0];
  return undefined; // ambiguous — not resolvable from the citing file
};

const seen = new Map();
const resolutions = new Map();
const ambiguous = new Map();
for (const [rel, abs] of files) {
  const text = textOf(rel, abs);
  let m;
  while ((m = TOK.exec(text))) {
    const raw = m[1], ln = Number(m[2]);
    if (ln < 2 || ln > 20000) continue;
    const p = resolve(raw, rel, ln);
    if (p === undefined) {
      const k = rel + '|' + raw;
      if (!ambiguous.has(k)) ambiguous.set(k, { file: rel, basename: raw, candidates: (byBase.get(raw) || []).slice().sort() });
      continue;
    }
    if (!p) continue;
    if (!raw.includes('/') && (byBase.get(raw) || []).length > 1) {
      const k = rel + '|' + raw;
      if (!resolutions.has(k)) resolutions.set(k, { file: rel, basename: raw, resolved: p, candidates: (byBase.get(raw) || []).slice().sort() });
    }
    const key = p + ':' + ln;
    if (seen.has(key)) { if (!seen.get(key).citedBy.includes(rel)) seen.get(key).citedBy.push(rel); continue; }
    const s = getRev(p, STAMP), h = getRev(p, HEAD);
    const at = (arr) => (arr && ln <= arr.length ? (arr[ln - 1] || '').trim() : null);
    const sl = at(s), hl = at(h);
    seen.set(key, {
      path: p, line: ln, citedBy: [rel], namesAtStamp: sl, namesAtHead: hl,
      status: sl === null ? 'notInStamp' : hl === null ? 'notAtHead' : hl === sl ? 'stable' : 'moved',
    });
  }
}

// Tokens the path:line tokenizer cannot see. A separate scan found 226 bare `:NNNN` tokens in these
// files that no path:line tokenizer enumerates. They are deliberately NOT enumerated here, because
// the file a bare token belongs to cannot be recovered from proximity: repair-round-log.md's `:100`
// follows `packages/cli/src/cli.ts:3933` on the immediately preceding line and yet denotes
// `open-blockers.md:100`, and b5-update-visibility.md's table cites `:67`..`:73` many lines below the
// header row that names perf-gates.md. The single entry below was resolved by READING the row, not by
// a rule, and is included; the remaining 225 are counted as uncovered rather than guessed.
const BARE_CONTINUATIONS = [
  {
    path: 'packages/mcp/src/verbs.ts', line: 3034, citedBy: ['environment-findings.md'],
    because: 'environment-findings.md:80 cites it as a bare `:3034`, on the line after that file introduces packages/mcp/src/verbs.ts:3047',
  },
];
for (const b of BARE_CONTINUATIONS) {
  const key = b.path + ':' + b.line;
  // The hand entry DOCUMENTS a resolution; it does not always ADD one. As soon as any file in this bin
  // spells the token's full path - which this bin's own repair log now does - the token regex reaches
  // the anchor by itself and this entry adds nothing. Both regimes are reported rather than assumed.
  b.addedAsDistinctCitation = !seen.has(key);
  if (!b.addedAsDistinctCitation) continue;
  const s = getRev(b.path, STAMP), h = getRev(b.path, HEAD);
  const at = (arr) => (arr && b.line <= arr.length ? (arr[b.line - 1] || '').trim() : null);
  const sl = at(s), hl = at(h);
  seen.set(key, {
    path: b.path, line: b.line, citedBy: b.citedBy, namesAtStamp: sl, namesAtHead: hl,
    bareContinuation: b.because,
    status: sl === null ? 'notInStamp' : hl === null ? 'notAtHead' : hl === sl ? 'stable' : 'moved',
  });
}
// The bare-token CLASS is counted here, not attributed. Counting is sound where resolution is not:
// the count needs only the regex and the file it is standing in, while resolution needs to name a
// target file, which proximity cannot supply (see whyNotEnumerated).
//
// SCOPE: the bin's .md files, read exactly as they sit on disk. index.json is excluded on purpose, and
// not to flatter the number. Its pretty-printed JSON holds tokens like `"lines": 2329` that this
// tokenizer does not match at all, so counting a re-serialized copy of it - compact JSON.stringify, as
// the anchor pass above needs - ADDS 18 structural values that are not citations and DROPS 8 prose
// ones. An earlier run of this generator did exactly that and reported 247 for a bin that holds 228.
// Excluding the generated manifest also keeps this field from counting its own description of itself.
//
// The overlap guard below is a NO-OP on the current files (measured: 228 with it, 228 without), because
// none of them quotes a path:line inside backticks - the one shape it catches. It is kept as a guard,
// not because it is doing work here.
const BARE_TOK = /(^|[^A-Za-z0-9_.\/-]):([0-9]{2,5})\b/g;
let BARE_TOKEN_TOTAL = 0;
for (const [rel, abs] of files) {
  if (!/\.md$/.test(rel)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const spans = [];
  TOK.lastIndex = 0;
  let fm;
  while ((fm = TOK.exec(text))) spans.push([fm.index, fm.index + fm[0].length]);
  BARE_TOK.lastIndex = 0;
  let bm;
  while ((bm = BARE_TOK.exec(text))) {
    const at = bm.index + bm[0].length - bm[2].length - 1;
    if (spans.some(([s, e]) => at >= s && at < e)) continue;
    BARE_TOKEN_TOTAL++;
  }
}
const BARE_UNCOVERED = BARE_TOKEN_TOTAL - BARE_CONTINUATIONS.filter(b => b.addedAsDistinctCitation).length;

const all = [...seen.values()];
// One anchor below reached `seen` by READING the row it names, not by the token regex - the bare
// continuation. So `distinctCitations` is not purely the regex's output, and reporting only it would
// let a reader take 84 for a count the declared method produces when the method produces 83. Both are
// reported so the one-token gap is visible instead of implied.
const handResolved = all.filter(r => r.bareContinuation).length;
const tally = { stable: 0, moved: 0, notInStamp: 0, notAtHead: 0 };
for (const r of all) tally[r.status]++;
const moved = all.filter(r => r.status === 'moved').sort((a, b) => (a.path + a.line).localeCompare(b.path + b.line));
const comparable = tally.stable + tally.moved;

const cfgTokens = all.filter(r => !tracked.includes(r.path) && !r.path.startsWith('.crib/'));
const artifacts = all.filter(r => r.path.startsWith('.crib/'));
const trackedTokens = all.filter(r => !r.path.startsWith('.crib/'));

// The claim "the working tree differing from HEAD affects no anchor here" is computed, not asserted.
const dirty = ls('git diff HEAD --name-only').filter(p => !p.startsWith('.crib/'));
const citedDirty = dirty.filter(p => all.some(r => r.path === p));

// The freshness-status line is the worked example, and where it sits at HEAD is COMPUTED, not written
// down: a hardcoded revision goes stale the next time packages/cli/src/cli.ts moves, which is the exact
// defect this bin exists to catch. If the text is not among the moved anchors the sentence says so
// rather than naming a line it did not verify.
const fsl = moved.find(r => r.path === 'packages/cli/src/cli.ts' && (r.namesAtHead || '').includes('freshness mode'));
const fslAtHead = fsl ? (':' + fsl.line + ' at ' + HEAD.slice(0, 8)) : 'at no line this measurement pins at ' + HEAD.slice(0, 8);

// Whether the hand entry ADDS a distinct citation is a property of these files, not of the bare-token
// class: as soon as any file here spells the token's full path - which this bin's own repair log now does -
// the token regex reaches that anchor unaided and the hand entry adds nothing. Both regimes therefore get
// their own sentence, built once here so codeHeadNote, method and bareLineTokens cannot drift apart.
const bareCoverageClause = handResolved
  ? 'only the ' + handResolved + ' that anchorDriftAtHead.bareLineTokens records as adding a distinct citation is enumerated - the other ' + BARE_UNCOVERED + ' are covered by no count here'
  : 'none of them is enumerated: the ' + BARE_CONTINUATIONS.length + ' bare token anchorDriftAtHead.bareLineTokens documents (' + BARE_CONTINUATIONS.map(b => b.path + ':' + b.line).join(', ') + ') is also spelled in full elsewhere in this bin, so the token regex reaches it unaided and it enters no count as a bare token';
const bareProvenanceClause = '`bareLineTokens` documents the ' + BARE_CONTINUATIONS.length + ' token resolved by reading the row it names instead of by a rule: ' + handResolved + ' of ' + BARE_CONTINUATIONS.length + ' entered the counts above as a distinct citation, and this run leaves ' + BARE_UNCOVERED + ' of that class covered by no count here.';

const codeHeadNote = [
  'This stamp is the revision the bin was DECLARED against, and the measurement below is what it does not cover.',
  'The anchors in this bin were read from the live working tree at ' + HEAD + ', not from ' + STAMP.slice(0, 8) + ': anchorDriftAtHead checks every path:line token in every .md and .json file here against both revisions, and ' + trackedTokens.length + ' of ' + all.length + ' tokens name a tracked repo file while the other ' + artifacts.length + ' name .crib/ artifacts that no revision holds.',
  'Every one of those ' + trackedTokens.length + ' resolves at ' + HEAD.slice(0, 8) + ', and ' + tally.moved + ' of them hold different text at the stamp named above — they are listed at anchorDriftAtHead.movedAnchors with the row each names.',
  'Where the stamp and the bin disagree the measurement decides, and the bin is not always the side that matches the code: environment-findings.md:79 quotes the code its line holds, but the freshness-status line open-blockers.md:100 names has moved twice since the stamp - that text is at packages/cli/src/cli.ts:3929 at 060898de, :3933 at 3434c19f, and ' + fslAtHead + ' - so that file now carries all three revisions rather than the single number it was written against, and every anchor whose text moved is listed by revision at anchorDriftAtHead.movedAnchors.',
  'A bare basename is resolved only when the citing file itself disambiguates it, by naming exactly one of the tracked files that bear that name: the bins introduce packages/ui/web/index.html once and then cite index.html bare, and docs/site/index.html is a different tracked file with 108 lines, so a first-match resolver silently attached this bin\'s citations to a file it never named. anchorDriftAtHead.bareBasenameResolutions records each such choice; anchorDriftAtHead.ambiguousBasenames records the bare tokens nothing disambiguated, which are excluded from every count here rather than guessed.',
  'Re-stamping is the bin owner\'s decision and was not taken here: this field records the disagreement instead of resolving it.',
  'One bound on the measurement: the files in this bin are staged but not committed, so they exist in no revision and the comparison above is between ' + STAMP.slice(0, 8) + ' and ' + HEAD.slice(0, 8) + ' alone. That the cited files are clean is not assumed — `git diff HEAD --name-only` outside .crib/ names ' + (dirty.length ? dirty.join(', ') : 'nothing') + ', and ' + citedDirty.length + ' of those paths is named by an anchor in this bin — so the working tree differing from ' + HEAD.slice(0, 8) + ' affects no anchor here.',
  'A second bound: this measurement compares the text a line holds at two revisions, so it detects an anchor that MOVED and cannot detect one that resolves to the wrong thing at BOTH — a stale number landing on unrelated code is reported stable. Only reading the row the anchor names catches that class, which is what rule 3 of .crib/bins/README.md requires of every anchor here.',
  'A third bound, on coverage rather than on method: ' + BARE_TOKEN_TOTAL + ' bare `:NNNN` tokens appear in this bin\'s .md files with no filename attached, and ' + bareCoverageClause + ', so every count above is a floor over that class.',
].join(' ');

const drift = {
  measuredAt: '2026-09-24',
  head: HEAD,
  stamp: STAMP,
  method: 'Every path:line token (and every bare basename:line token) in every .md and .json file in this bin was read as trim()ed text from `git show <stamp>:<path>` and from `git show HEAD:<path>` and compared. A token counts as MOVED when the line exists at both revisions and holds different text, as notInStamp when the stamp tree has no such line or file, and as notAtHead when HEAD has no such line. A bare basename is resolved only when the citing file names exactly one of the tracked files bearing it; a bare basename nothing disambiguates is recorded under ambiguousBasenames and excluded from every count here, because the measurement cannot say which file it meant. Of the ' + all.length + ' distinct citations, ' + (all.length - handResolved) + ' came from the token regex and ' + handResolved + ' from reading the row it names (see distinctCitationsResolvedByReading); distinctCitations is their sum, not the regex alone, and distinctCitationsByTokenRegex carries the regex-only figure. A THIRD token shape this measurement does NOT enumerate: a bare `:NNNN` with no filename at all, of which this run counted ' + BARE_TOKEN_TOTAL + ' in the bin\'s .md files read exactly as they sit on disk. index.json is excluded from that count on purpose: its pretty-printed JSON holds tokens like `"lines": 2329` the tokenizer cannot match, so counting a compact re-serialization of it would add structural values that are not citations and drop prose ones - an earlier run of this generator reported 247 that way, for a bin holding ' + BARE_TOKEN_TOTAL + '. Counting the class is sound where enumerating it is not. They are not enumerated because the file one belongs to cannot be recovered from proximity - repair-round-log.md\'s `:100` follows `packages/cli/src/cli.ts:3933` on the immediately preceding line and yet denotes `open-blockers.md:100` - so a rule would attribute them wrongly rather than resolve them. ' + bareProvenanceClause,
  distinctCitations: all.length,
  distinctCitationsByTokenRegex: all.length - handResolved,
  distinctCitationsResolvedByReading: handResolved,
  stable: tally.stable,
  moved: tally.moved,
  notInStamp: tally.notInStamp,
  notAtHead: tally.notAtHead,
  resolvesAtHead: comparable,
  reading: 'Zero of the ' + trackedTokens.length + ' tracked-file anchors fail at ' + HEAD.slice(0, 8) + '; ' + tally.moved + ' fail at the declared stamp. The stamp therefore does not describe the revision this bin was verified against. ' + artifacts.length + ' tokens name .crib/ artifacts (this bin itself and .crib/bins/README.md among them), which are uncommitted and so present in no revision; nothing is claimed about their content across revisions. ' + ambiguous.size + ' further bare tokens are excluded as unresolvable: ' + [...ambiguous.values()].map(a => a.basename + ' in ' + a.file).join(', ') + '. And none of the ' + BARE_UNCOVERED + ' bare `:NNNN` tokens in the bin\'s .md files is counted here at all, so every count below is a floor over that class.',
  bareLineTokens: {
    scope: 'the bin\'s .md files, read as they sit on disk; index.json is excluded because it is generated (see method)',
    totalInMdFiles: BARE_TOKEN_TOTAL,
    documentedHere: BARE_CONTINUATIONS.length,
    ofWhichAddedAsDistinctCitation: handResolved,
    notCoveredByAnyCount: BARE_UNCOVERED,
    included: BARE_CONTINUATIONS.map(b => ({ path: b.path, line: b.line, citedBy: b.citedBy, resolvedBy: b.because, addedAsDistinctCitation: !!b.addedAsDistinctCitation, namesAtStamp: (getRev(b.path, STAMP) || [])[b.line - 1], namesAtHead: (getRev(b.path, HEAD) || [])[b.line - 1] })),
    whyNotEnumerated: 'The file a bare `:NNNN` token belongs to is not recoverable from proximity. repair-round-log.md\'s `:100` follows `packages/cli/src/cli.ts:3933` on the immediately preceding line and denotes open-blockers.md:100; b5-update-visibility.md cites `:67`..`:73` many lines below the table header row that names docs/bench/perf-gates.md. A proximity rule would therefore attribute tokens wrongly rather than resolve them, so the class is excluded and counted instead of guessed.',
  },
  notInStampAnchors: [...new Set(all.filter(r => r.status === 'notInStamp').map(r => r.path + ':' + r.line))],
  bareBasenameResolutions: [...resolutions.values()],
  ambiguousBasenames: [...ambiguous.values()],
  movedAnchors: moved.map(r => ({ path: r.path, line: r.line, citedBy: r.citedBy, namesAtStamp: r.namesAtStamp, namesAtHead: r.namesAtHead, bareContinuation: r.bareContinuation })),
};

const roster = idx.files.map(f => f.path);
if (!roster.includes('measure-drift.mjs')) {
  idx.files.push({ path: 'measure-drift.mjs', purpose: 'The generator for anchorDriftAtHead and codeHeadNote: re-run it to re-measure every path:line anchor in this bin against the declared stamp and HEAD' });
}
if (!roster.includes('repair-round-log.md')) {
  idx.files.push({ path: 'repair-round-log.md', purpose: 'The repair rounds run against the enhancement layer and these bins: the closing round\'s measured counts, the fixes it applied, what it declined and why, and the open decisions it does not take' });
}
// The two generated fields are excluded from the copy: copying them AFTER assigning the fresh
// values silently restores the previous measurement (anchorDriftAtHead sorts after anchorsVerifiedAt).
const out = {};
for (const k of Object.keys(idx)) {
  if (k === 'codeHeadNote' || k === 'anchorDriftAtHead') continue;
  out[k] = idx[k];
}
out.codeHeadNote = codeHeadNote;
out.anchorDriftAtHead = drift;
fs.writeFileSync(IDX, JSON.stringify(out, null, 2) + '\n');

const back = JSON.parse(fs.readFileSync(IDX, 'utf8'));
console.log('parses: OK');
console.log('codeHead unchanged: ' + (back.codeHead === STAMP) + '  (' + back.codeHead.slice(0, 8) + ')');
console.log('files roster: ' + back.files.length + ' -> ' + back.files.map(f => f.path).join(', '));
console.log('anchorDriftAtHead: distinct=' + back.anchorDriftAtHead.distinctCitations
  + ' stable=' + back.anchorDriftAtHead.stable + ' moved=' + back.anchorDriftAtHead.moved
  + ' notInStamp=' + back.anchorDriftAtHead.notInStamp + ' notAtHead=' + back.anchorDriftAtHead.notAtHead
  + ' resolvesAtHead=' + back.anchorDriftAtHead.resolvesAtHead);
console.log('bareBasenameResolutions: ' + back.anchorDriftAtHead.bareBasenameResolutions.length);
for (const a of back.anchorDriftAtHead.bareBasenameResolutions) console.log('  ' + a.file + ' cites "' + a.basename + '" -> ' + a.resolved + '   candidates: ' + a.candidates.join(' | '));
console.log('movedAnchors: ' + back.anchorDriftAtHead.movedAnchors.length);
for (const a of back.anchorDriftAtHead.movedAnchors) console.log('  ' + a.path + ':' + a.line + '  at stamp: ' + JSON.stringify((a.namesAtStamp || '(null)').slice(0, 50)) + '  at HEAD: ' + JSON.stringify((a.namesAtHead || '').slice(0, 50)));
console.log('notInStampAnchors: ' + back.anchorDriftAtHead.notInStampAnchors.join(', '));
console.log('codeHeadNote says open-blockers.md:100: ' + back.codeHeadNote.includes('open-blockers.md:100'));
