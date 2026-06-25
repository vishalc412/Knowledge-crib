/**
 * Dossier (Workstream E) — the persisted "reusable deep context" artifact: builder + markdown
 * serializer + sharded/atomic/hash-stale persistence. See {@link './builder.js'}.
 */
export { buildDossier, publicNode } from './builder.js';
export type {
  Dossier,
  DossierOpts,
  AdjacentBrief,
  DossierDocLink,
  DossierControlFlow,
} from './builder.js';
export { dossierToMarkdown } from './serializer.js';
export {
  dossiersDir,
  dossierPath,
  writeDossier,
  readDossier,
  deleteDossier,
} from './persist.js';
export type { DossierRead } from './persist.js';
