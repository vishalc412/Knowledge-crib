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
  DossierImplementation,
} from './builder.js';
export { dossierToMarkdown } from './serializer.js';
export {
  buildReconstruction,
  reconstructionToMarkdown,
  expectedBodyFile,
  RECONSTRUCTION_SHAPE_VERSION,
} from './reconstruct.js';
export type {
  Reconstruction,
  ReconstructionOpts,
  ReconstructionVariable,
  ReconstructionMember,
  ReconstructionTable,
  ReconstructionDoc,
} from './reconstruct.js';
export { buildDossiersByScope } from './by-scope.js';
export type {
  DossiersByScope,
  DossiersByScopeOpts,
  DossierScope,
} from './by-scope.js';
export { computeCoverage } from './coverage.js';
export type { CallableCoverage, CoverageCalls } from './coverage.js';
export { frameworkSemantics, DOSSIER_SHAPE_VERSION } from './framework.js';
export type {
  DossierFrameworkSemantics,
  DossierRoute,
  DossierProduces,
  DossierDependency,
  DossierDependent,
  DossierRelation,
  DossierRenders,
  ParamLocation,
  FrameworkSemanticsOpts,
} from './framework.js';
export {
  dossiersDir,
  dossierPath,
  writeDossier,
  readDossier,
  deleteDossier,
  pruneDossiers,
} from './persist.js';
export type { DossierRead } from './persist.js';
