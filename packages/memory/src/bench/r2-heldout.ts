/**
 * R2-HELDOUT — the held-out split for `docs/bench/retrieval-pre-registration-r2.md`.
 *
 * SELF-CONTAINED on purpose. R2 exists because the earlier semantic result was produced by sweeping
 * against the launch-gate corpus, which is selection on the test set. A held-out split that imported
 * its topics from that corpus would reproduce the error, so every claim, query and paraphrase below
 * is newly authored and appears in NO other corpus in this repository (asserted by
 * `r2-heldout.test.ts`, which diffs against both `launch-corpus.ts` and `scenarios.ts`).
 *
 * Scope, stated honestly: R2's decision rule (§5) turns on held-out recall@5 over the word-disjoint
 * `paraphrase` family plus an `exact` guard. Those are the only families that decide anything, so
 * this split carries exactly them, plus `multilingual` (also word-disjoint, and the family where the
 * embedder choice showed the largest effect). The classification families — temporal, contradiction,
 * adversarial, cross-principal — feed launch gates G4–G8, which R2 does not decide and does not
 * touch; they stay in `launch-corpus.ts`.
 *
 * Construction invariants (R2 §4, all asserted by the test file):
 *   1. zero content-token overlap between a query and its labeled claim (per LAUNCH_STOPWORDS);
 *   2. no query token is an FTS PREFIX of a claim token (a prefix still matches lexically and would
 *      fake semantic recall);
 *   3. one distinct claim template per record — no clone dilution (the P0 corpus violated this and
 *      capped its own MRR at ≈0.46 regardless of retriever);
 *   4. byte-deterministic — no randomness, no wall clock.
 *
 * The `m` mod token appears ONLY in the claim and the exact query, never in a paraphrase or a
 * translation, so the paraphrase families carry no lexical handle at all.
 */
import type { MemoryRecord } from '../types.js';
import { benchHash, buildBenchRecord, quoteEvidence } from './corpus.js';
import type { LaunchCategory, LaunchQuery } from './launch-corpus.js';

/**
 * Non-English FUNCTION words, layered on top of `LAUNCH_STOPWORDS` (which is English-only) when the
 * disjointness invariant is checked against a multilingual query.
 *
 * These are closed-class articles/prepositions carrying no content — exactly what a stoplist is for.
 * Without them the invariant produces false positives, because a Spanish article like `un` is an FTS
 * prefix of an unrelated English claim token like `unique`: a collision of spelling, not of meaning,
 * and no retriever gains a lexical handle from it. Deliberately closed-class only — no nouns, verbs
 * or adjectives are ever added here, since that WOULD hide a real overlap.
 */
export const R2_NON_ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  // es
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'de',
  'del',
  'y',
  'o',
  'se',
  'con',
  'por',
  'para',
  'al',
  'lo',
  'su',
  'sus',
  'como',
  'cada',
  'solo',
  'cuando',
  'antes',
  'sin',
  'no',
  // de
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'ein',
  'eine',
  'einem',
  'einen',
  'einer',
  'und',
  'mit',
  'von',
  'vom',
  'zum',
  'zur',
  'im',
  'auf',
  'aus',
  'bei',
  'nach',
  'vor',
  'wird',
  'werden',
  'er',
  'jede',
  'jeder',
  'nicht',
  'erst',
  'damit',
  'ist',
  // fr
  'le',
  'les',
  'une',
  'des',
  'du',
  'et',
  'en',
  'par',
  'avec',
  'pour',
  'sur',
  'dans',
  'est',
  'sont',
  'ne',
  'pas',
  'que',
  'qui',
  'ou',
  'chaque',
  'seulement',
  'avant',
  'apres',
  'plusieurs',
  'fois',
]);

/** A topic: `claim(m)` is the record, `exact(m)` shares its tokens, `para` shares none. */
interface R2Topic {
  claim: (m: string) => string;
  exact: (m: string) => string;
  para: string;
}

/** A multilingual topic: one English claim, four word-disjoint non-English queries. */
interface R2Multilingual {
  claim: (m: string) => string;
  es: string;
  de: string;
  fr: string;
  ja: string;
}

// ─── decisions (20) ──────────────────────────────────────────────────────────

const R2_DECISIONS: readonly R2Topic[] = [
  {
    claim: (m) => `${m} stores money as integer minor units, never floating point`,
    exact: (m) => `${m} stores money integer minor units floating`,
    para: 'currency amounts are kept as whole counts to avoid rounding drift',
  },
  {
    claim: (m) => `${m} rejects requests larger than one megabyte at the edge`,
    exact: (m) => `${m} rejects requests larger megabyte edge`,
    para: 'oversized payloads are turned away before they reach any handler',
  },
  {
    claim: (m) => `${m} keeps the write path synchronous and fans out reads asynchronously`,
    exact: (m) => `${m} keeps write path synchronous fans reads`,
    para: 'saving blocks the caller while distribution happens in the background',
  },
  {
    claim: (m) => `${m} pins every container image by digest rather than a moving tag`,
    exact: (m) => `${m} pins container image digest moving tag`,
    para: 'runtime bundles are addressed by exact content so rebuilds cannot shift',
  },
  {
    claim: (m) => `${m} treats the database as the single source of truth for ordering`,
    exact: (m) => `${m} treats database single source truth ordering`,
    para: 'sequence is decided by persistent storage and never by the application clock',
  },
  {
    claim: (m) => `${m} expires idle sessions after fifteen minutes of inactivity`,
    exact: (m) => `${m} expires idle sessions fifteen minutes inactivity`,
    para: 'dormant logins are dropped once a short quiet window passes',
  },
  {
    claim: (m) => `${m} serves static assets from the CDN with immutable cache headers`,
    exact: (m) => `${m} serves static assets CDN immutable cache headers`,
    para: 'unchanging files come from the distribution layer and are never revalidated',
  },
  {
    claim: (m) => `${m} runs schema checks in continuous integration, not at startup`,
    exact: (m) => `${m} runs schema checks continuous integration startup`,
    para: 'structure validation happens during the build rather than when a process boots',
  },
  {
    claim: (m) => `${m} isolates tenants by row level security rather than separate databases`,
    exact: (m) => `${m} isolates tenants row level security separate databases`,
    para: 'customer separation is enforced inside one store by per record rules',
  },
  {
    claim: (m) => `${m} prefers composition over inheritance in the domain layer`,
    exact: (m) => `${m} prefers composition inheritance domain layer`,
    para: 'business objects are assembled from parts instead of extending a base type',
  },
  {
    claim: (m) => `${m} returns problem details documents for every error response`,
    exact: (m) => `${m} returns problem details documents error response`,
    para: 'failures come back in a standard machine readable envelope',
  },
  {
    claim: (m) => `${m} keeps background jobs idempotent so retries are always safe`,
    exact: (m) => `${m} keeps background jobs idempotent retries safe`,
    para: 'deferred work can run twice without changing the outcome',
  },
  {
    claim: (m) => `${m} caps request concurrency per tenant to protect noisy neighbours`,
    exact: (m) => `${m} caps request concurrency tenant noisy neighbours`,
    para: 'one customer cannot starve the others because parallel work is bounded',
  },
  {
    claim: (m) => `${m} signs webhooks with a shared secret and a timestamp`,
    exact: (m) => `${m} signs webhooks shared secret timestamp`,
    para: 'outbound callbacks carry proof of origin and a freshness marker',
  },
  {
    claim: (m) => `${m} stores timestamps in UTC and converts only at the presentation edge`,
    exact: (m) => `${m} stores timestamps UTC converts presentation edge`,
    para: 'moments are persisted in one absolute zone and localised just before display',
  },
  {
    claim: (m) => `${m} fails the build when test coverage drops below the recorded floor`,
    exact: (m) => `${m} fails build test coverage drops recorded floor`,
    para: 'a fall in exercised code stops the pipeline rather than warning quietly',
  },
  {
    claim: (m) => `${m} publishes events after the transaction commits, never inside it`,
    exact: (m) => `${m} publishes events after transaction commits inside`,
    para: 'notifications leave only once durable storage has accepted the change',
  },
  {
    claim: (m) => `${m} keeps configuration immutable per deployment, reloaded only on restart`,
    exact: (m) => `${m} keeps configuration immutable deployment reloaded restart`,
    para: 'settings are fixed for the life of a process and change by replacing it',
  },
  {
    claim: (m) => `${m} authorises on the server for every action, never trusting the client`,
    exact: (m) => `${m} authorises server every action trusting client`,
    para: 'entitlement is settled centrally and the caller receives no confidence',
  },
  {
    claim: (m) => `${m} retains audit records for seven years in cold storage`,
    exact: (m) => `${m} retains audit records seven years cold storage`,
    para: 'compliance history is archived cheaply for a very long period',
  },
];

// ─── preferences (12) ────────────────────────────────────────────────────────

const R2_PREFERENCES: readonly R2Topic[] = [
  {
    claim: (m) => `${m} the reviewer wants diffs under four hundred lines`,
    exact: (m) => `${m} reviewer wants diffs four hundred lines`,
    para: 'change sets should stay small enough to read in one sitting',
  },
  {
    claim: (m) => `${m} the team writes commit subjects in the imperative mood`,
    exact: (m) => `${m} team writes commit subjects imperative mood`,
    para: 'version history summaries are phrased as instructions rather than past tense',
  },
  {
    claim: (m) => `${m} the author prefers explicit return types on exported functions`,
    exact: (m) => `${m} author prefers explicit return types exported functions`,
    para: 'publicly reachable routines should declare what they hand back',
  },
  {
    claim: (m) => `${m} the maintainer dislikes mocking in integration tests`,
    exact: (m) => `${m} maintainer dislikes mocking integration tests`,
    para: 'end to end checks should exercise real collaborators instead of stand ins',
  },
  {
    claim: (m) => `${m} the owner wants comments to explain why, not what`,
    exact: (m) => `${m} owner wants comments explain why what`,
    para: 'inline prose should capture reasoning rather than restating the instructions',
  },
  {
    claim: (m) => `${m} the lead asks for feature branches to live under two days`,
    exact: (m) => `${m} lead asks feature branches live two days`,
    para: 'side lines of development ought to merge back almost immediately',
  },
  {
    claim: (m) => `${m} the reviewer requires a failing test before any bug fix`,
    exact: (m) => `${m} reviewer requires failing test before bug fix`,
    para: 'reproduce the defect first, then correct it',
  },
  {
    claim: (m) => `${m} the team avoids abbreviations in public identifiers`,
    exact: (m) => `${m} team avoids abbreviations public identifiers`,
    para: 'externally visible names should be spelled out in full',
  },
  {
    claim: (m) => `${m} the author wants dependencies vendored rather than fetched at build`,
    exact: (m) => `${m} author wants dependencies vendored fetched build`,
    para: 'third party code should be checked in instead of pulled during compilation',
  },
  {
    claim: (m) => `${m} the owner prefers flat module layout over deep nesting`,
    exact: (m) => `${m} owner prefers flat module layout deep nesting`,
    para: 'directory structure should stay shallow rather than many levels down',
  },
  {
    claim: (m) => `${m} the maintainer wants every public symbol documented`,
    exact: (m) => `${m} maintainer wants every public symbol documented`,
    para: 'anything callable from outside needs an explanatory note',
  },
  {
    claim: (m) => `${m} the team runs formatters on save, never in review`,
    exact: (m) => `${m} team runs formatters save review`,
    para: 'layout is normalised by the editor rather than argued about later',
  },
];

// ─── procedures (12) ─────────────────────────────────────────────────────────

const R2_PROCEDURES: readonly R2Topic[] = [
  {
    claim: (m) => `${m} to rotate the signing key, mint the new one then drain the old for a day`,
    exact: (m) => `${m} rotate signing key mint drain old day`,
    para: 'swap the certificate by overlapping both for twenty four hours then retiring the earlier copy',
  },
  {
    claim: (m) => `${m} to restore a backup, stop writers, replay the log, then reopen traffic`,
    exact: (m) => `${m} restore backup stop writers replay log reopen traffic`,
    para: 'recovering data means pausing input, catching up, then letting users return',
  },
  {
    claim: (m) => `${m} to add a column, ship it nullable first and backfill in batches`,
    exact: (m) => `${m} add column ship nullable backfill batches`,
    para: 'introduce a new field as optional and populate it gradually',
  },
  {
    claim: (m) => `${m} to debug a hang, capture a thread dump before restarting anything`,
    exact: (m) => `${m} debug hang capture thread dump restarting`,
    para: 'when a process stops responding, take a snapshot of its state first',
  },
  {
    claim: (m) => `${m} to onboard a service, register it in the catalogue then wire alerts`,
    exact: (m) => `${m} onboard service register catalogue wire alerts`,
    para: 'a new component is listed in the directory before monitoring is attached',
  },
  {
    claim: (m) => `${m} to roll back, redeploy the previous digest and leave the data alone`,
    exact: (m) => `${m} roll back redeploy previous digest leave data`,
    para: 'reverting means shipping the earlier build without touching stored records',
  },
  {
    claim: (m) => `${m} to widen a rate limit, raise the burst before raising the sustained rate`,
    exact: (m) => `${m} widen rate limit raise burst sustained`,
    para: 'loosen throttling by allowing short spikes ahead of steady growth',
  },
  {
    claim: (m) => `${m} to retire an endpoint, log usage for a month then return gone`,
    exact: (m) => `${m} retire endpoint log usage month return gone`,
    para: 'remove an interface by watching callers first and then refusing them',
  },
  {
    claim: (m) => `${m} to reproduce a report, pin the seed and replay the recorded input`,
    exact: (m) => `${m} reproduce report pin seed replay recorded input`,
    para: 'recreate an issue by fixing randomness and feeding the captured data again',
  },
  {
    claim: (m) => `${m} to promote a build, copy the artifact rather than rebuilding it`,
    exact: (m) => `${m} promote build copy artifact rebuilding`,
    para: 'move a candidate forward by reusing the same compiled output',
  },
  {
    claim: (m) => `${m} to clear the queue, drain consumers before deleting the topic`,
    exact: (m) => `${m} clear queue drain consumers deleting topic`,
    para: 'empty a backlog by letting readers finish ahead of removing the channel',
  },
  {
    claim: (m) => `${m} to audit permissions, export the grants and diff against the baseline`,
    exact: (m) => `${m} audit permissions export grants diff baseline`,
    para: 'review access by dumping what is allowed and comparing with the agreed list',
  },
];

// ─── failures (12) ───────────────────────────────────────────────────────────

const R2_FAILURES: readonly R2Topic[] = [
  {
    claim: (m) => `${m} the retry storm took the database down after a brief timeout`,
    exact: (m) => `${m} retry storm took database down brief timeout`,
    para: 'repeated automatic attempts overwhelmed storage once latency rose slightly',
  },
  {
    claim: (m) => `${m} a missing index turned the report into a full table scan`,
    exact: (m) => `${m} missing index turned report full table scan`,
    para: 'without a lookup structure the summary read every row',
  },
  {
    claim: (m) => `${m} the clock skew between hosts expired tokens early`,
    exact: (m) => `${m} clock skew between hosts expired tokens early`,
    para: 'machines disagreeing about time invalidated credentials ahead of schedule',
  },
  {
    claim: (m) => `${m} the unbounded cache grew until the process was killed`,
    exact: (m) => `${m} unbounded cache grew until process killed`,
    para: 'a hoard with no eviction limit consumed memory and got terminated',
  },
  {
    claim: (m) => `${m} a silent catch swallowed the parse error for months`,
    exact: (m) => `${m} silent catch swallowed parse error months`,
    para: 'an empty handler hid malformed input for a very long time',
  },
  {
    claim: (m) => `${m} the migration locked the table and blocked every writer`,
    exact: (m) => `${m} migration locked table blocked every writer`,
    para: 'a structure change held exclusive access and stalled all updates',
  },
  {
    claim: (m) => `${m} the health check passed while the dependency was unreachable`,
    exact: (m) => `${m} health check passed dependency unreachable`,
    para: 'the liveness probe reported fine although a required collaborator had gone offline',
  },
  {
    claim: (m) => `${m} duplicate delivery double charged the customer`,
    exact: (m) => `${m} duplicate delivery double charged customer`,
    para: 'the same message arriving twice billed a person for one purchase twice',
  },
  {
    claim: (m) => `${m} the connection pool leaked because handles were never closed`,
    exact: (m) => `${m} connection pool leaked handles never closed`,
    para: 'resources ran out since open sockets went unreleased',
  },
  {
    claim: (m) => `${m} an eager regex backtracked and pinned the worker`,
    exact: (m) => `${m} eager regex backtracked pinned worker`,
    para: 'a greedy pattern consumed an entire core on some inputs',
  },
  {
    claim: (m) => `${m} the feature flag defaulted on in production before review`,
    exact: (m) => `${m} feature flag defaulted production before review`,
    para: 'an unfinished toggle was live for real users ahead of approval',
  },
  {
    claim: (m) => `${m} truncated logs hid the root cause during the incident`,
    exact: (m) => `${m} truncated logs hid root cause incident`,
    para: 'cut off diagnostic output concealed why the outage began',
  },
];

// ─── refactors (10) ──────────────────────────────────────────────────────────

const R2_REFACTORS: readonly R2Topic[] = [
  {
    claim: (m) => `${m} the parser moved from a hand rolled loop to a table driven state machine`,
    exact: (m) => `${m} parser moved hand rolled loop table driven state machine`,
    para: 'reading logic changed from bespoke iteration to a lookup based design',
  },
  {
    claim: (m) => `${m} the god object split into a reader, a writer, and a validator`,
    exact: (m) => `${m} god object split reader writer validator`,
    para: 'one oversized type became three focused collaborators',
  },
  {
    claim: (m) => `${m} the callback chain became async await throughout`,
    exact: (m) => `${m} callback chain became async await throughout`,
    para: 'nested continuation style gave way to linear suspension syntax',
  },
  {
    claim: (m) => `${m} inheritance in the pricing tree collapsed into a strategy map`,
    exact: (m) => `${m} inheritance pricing tree collapsed strategy map`,
    para: 'a deep type hierarchy for cost rules became a dictionary of behaviours',
  },
  {
    claim: (m) => `${m} the shared mutable singleton became an injected dependency`,
    exact: (m) => `${m} shared mutable singleton became injected dependency`,
    para: 'a global changeable instance is now handed in by the caller',
  },
  {
    claim: (m) => `${m} string concatenation for queries moved to bound parameters`,
    exact: (m) => `${m} string concatenation queries moved bound parameters`,
    para: 'statements are now assembled with placeholders instead of glued text',
  },
  {
    claim: (m) => `${m} the polling loop was replaced by a change stream subscription`,
    exact: (m) => `${m} polling loop replaced change stream subscription`,
    para: 'repeated checking gave way to being notified when something moves',
  },
  {
    claim: (m) => `${m} duplicated validation across handlers moved into one middleware`,
    exact: (m) => `${m} duplicated validation handlers moved middleware`,
    para: 'repeated input guards became a single shared stage',
  },
  {
    claim: (m) => `${m} the monolithic module was carved along its transaction boundaries`,
    exact: (m) => `${m} monolithic module carved transaction boundaries`,
    para: 'a single large component got split where units of committed change already ended',
  },
  {
    claim: (m) => `${m} implicit any types were replaced with generated schema types`,
    exact: (m) => `${m} implicit any types replaced generated schema types`,
    para: 'untyped values now carry declarations produced from the contract',
  },
];

// ─── multilingual (8 claims × 4 languages = 32 queries) ──────────────────────

const R2_MULTILINGUAL: readonly R2Multilingual[] = [
  {
    claim: (m) => `${m} the scheduler retries a failed task three times before giving up`,
    es: 'el planificador vuelve a intentar una tarea fallida varias veces antes de rendirse',
    de: 'der Planer wiederholt eine fehlgeschlagene Aufgabe mehrmals bevor er aufgibt',
    fr: 'le planificateur relance une besogne ratee plusieurs fois avant de renoncer',
    ja: 'スケジューラは失敗したタスクを数回再実行してから諦めます',
  },
  {
    claim: (m) => `${m} uploaded files are scanned for malware before they are stored`,
    es: 'los archivos subidos se analizan en busca de software malicioso antes de guardarlos',
    de: 'hochgeladene Dateien werden vor dem Speichern auf Schadsoftware kontrolliert',
    fr: 'les fichiers transmis sont inspectes contre les logiciels malveillants avant conservation',
    ja: 'アップロードされたファイルは保存前に不正なプログラムを検査されます',
  },
  {
    claim: (m) => `${m} the api returns a cursor so clients can page through large results`,
    es: 'la interfaz entrega un puntero para recorrer resultados extensos por partes',
    de: 'die Schnittstelle liefert eine Marke damit umfangreiche Ergebnisse abschnittsweise gelesen werden',
    fr: 'une interface transmet un jalon permettant de parcourir de vastes tableaux par tranches',
    ja: 'インターフェースは大きな結果を分割して読むための目印を返します',
  },
  {
    claim: (m) => `${m} passwords are hashed with a slow algorithm and a unique salt`,
    es: 'las claves secretas se transforman con un procedimiento lento y un valor distinto por persona',
    de: 'Kennworte werden mit einem langsamen Verfahren und einem einmaligen Zusatzwert gesichert',
    fr: 'les codes secrets sont convertis par un traitement lent avec une valeur distincte',
    ja: 'パスワードは低速な方式と利用者ごとの固有値で変換されます',
  },
  {
    claim: (m) => `${m} the worker acknowledges a message only after the work completes`,
    es: 'el programa confirma la recepcion solo cuando la labor ha concluido',
    de: 'der Ablauf bestaetigt eine Meldung erst nachdem die Aufgabe beendet ist',
    fr: 'le programme confirme la reception seulement une fois la besogne achevee',
    ja: '処理は作業が終わってから初めてメッセージを確認します',
  },
  {
    claim: (m) => `${m} deleted rows are marked hidden and purged after thirty days`,
    es: 'las lineas borradas se marcan como ocultas y se eliminan definitivamente al cabo de un mes',
    de: 'entfernte Zeilen werden als verborgen markiert und nach einem Monat endgueltig getilgt',
    fr: 'les lignes retirees sont marquees masquees puis effacees definitivement apres un mois',
    ja: '削除された行は非表示として印を付けられ一ヶ月後に完全に消去されます',
  },
  {
    claim: (m) => `${m} every outbound email includes an unsubscribe link in the footer`,
    es: 'cada correo enviado incluye un enlace para darse de baja al final del texto',
    de: 'jede versandte Mitteilung enthaelt am Ende einen Verweis zum Abbestellen',
    fr: 'chaque courrier expedie contient en bas un lien de desinscription',
    ja: '送信される各メールの末尾には配信停止のためのリンクが含まれます',
  },
  {
    claim: (m) => `${m} the report aggregates nightly and is never computed on request`,
    es: 'el resumen se calcula cada noche y jamas al momento de pedirlo',
    de: 'die Auswertung wird jede Nacht berechnet und niemals bei der Anfrage',
    fr: 'le bilan est calcule chaque nuit et jamais au moment de la demande',
    ja: '集計は毎晩行われ要求時に計算されることはありません',
  },
];

// ─── emission ────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** Deterministic timestamps — no wall clock ever enters the corpus (invariant 4). */
const stamp = (month: number, i: number): string =>
  `2027-${pad2(month)}-${pad2((i % 27) + 1)}T00:00:00.000Z`;

function emitTopics(
  bank: readonly R2Topic[],
  kind: 'decision' | 'fact' | 'procedure' | 'pitfall',
  modPrefix: string,
  subjectOf: (m: string) => string,
  month: number,
  category: LaunchCategory,
): { records: MemoryRecord[]; queries: LaunchQuery[] } {
  const records: MemoryRecord[] = [];
  const queries: LaunchQuery[] = [];
  for (let i = 0; i < bank.length; i++) {
    const topic = bank[i]!;
    const mod = `${modPrefix}${i}`;
    const subject = subjectOf(mod);
    const claim = topic.claim(mod);
    const record = buildBenchRecord({
      kind,
      subject,
      claim,
      appliesTo: [subject],
      evidence: [quoteEvidence(subject, claim, benchHash('live'))],
      createdAt: stamp(month, i),
      actor: i % 2 === 0 ? 'agent:claude-code' : 'agent:codex',
    });
    records.push(record);
    queries.push({ query: topic.exact(mod), relevantIds: [record.id], category, family: 'exact' });
    queries.push({ query: topic.para, relevantIds: [record.id], category, family: 'paraphrase' });
  }
  return { records, queries };
}

export interface R2Heldout {
  records: MemoryRecord[];
  queries: LaunchQuery[];
}

/**
 * Build R2-HELDOUT. Byte-deterministic: two builds are identical, and every id is content-addressed
 * from the claim, so the split can be rebuilt anywhere and compared.
 */
export function buildR2Heldout(): R2Heldout {
  const records: MemoryRecord[] = [];
  const queries: LaunchQuery[] = [];
  const add = (e: { records: MemoryRecord[]; queries: LaunchQuery[] }): void => {
    records.push(...e.records);
    queries.push(...e.queries);
  };

  add(emitTopics(R2_DECISIONS, 'decision', 'r2dec', (m) => `decision:${m}`, 1, 'decisions'));
  add(emitTopics(R2_PREFERENCES, 'fact', 'r2pref', (m) => `topic:pref-${m}`, 2, 'preferences'));
  add(
    emitTopics(
      R2_PROCEDURES,
      'procedure',
      'r2proc',
      (m) => `sym:src/${m}.ts#${m}Runbook@L1`,
      3,
      'procedures',
    ),
  );
  add(
    emitTopics(
      R2_FAILURES,
      'pitfall',
      'r2fail',
      (m) => `sym:src/${m}.ts#${m}Pitfall@L1`,
      4,
      'failures',
    ),
  );
  add(
    emitTopics(
      R2_REFACTORS,
      'decision',
      'r2ref',
      (m) => `sym:src/${m}.ts#${m}Refactor@L1`,
      5,
      'refactors',
    ),
  );

  // multilingual: one English record, four non-English queries, none sharing a token with the claim
  for (let i = 0; i < R2_MULTILINGUAL.length; i++) {
    const topic = R2_MULTILINGUAL[i]!;
    const mod = `r2ml${i}`;
    const subject = `sym:src/${mod}.ts#${mod}Service@L1`;
    const claim = topic.claim(mod);
    const record = buildBenchRecord({
      kind: 'fact',
      subject,
      claim,
      appliesTo: [subject],
      evidence: [quoteEvidence(subject, claim, benchHash('live'))],
      createdAt: stamp(6, i),
      actor: i % 2 === 0 ? 'agent:claude-code' : 'agent:codex',
    });
    records.push(record);
    for (const q of [topic.es, topic.de, topic.fr, topic.ja]) {
      queries.push({
        query: q,
        relevantIds: [record.id],
        category: 'multilingual',
        family: 'multilingual',
      });
    }
  }

  return { records, queries };
}
