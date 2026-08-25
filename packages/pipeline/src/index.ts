/**
 * @knowledge-crib/pipeline — the phased extract→graph→index pipeline.
 */
export * from './structure.js';
export * from './gitignore.js';
export * from './parse.js';
export * from './pipeline.js';
export * from './resolve/index.js';
export * from './linker/index.js';
export * from './multimodal/index.js';
export * from './update.js';
export * from './working-overlay-refresh.js';
export * from './vcs.js';
export * from './workspace.js';
export { makeExtractCtx } from './extract-ctx.js';
export * from './rules/index.js';
export * from './cluster/index.js';
export { classifyMuleFiles } from './mule/classify.js';
export type { MuleClassificationResult } from './mule/classify.js';
export {
  classifyMuleDiscovery,
  keyOnlyHash,
  pathOnlyHash,
  propertyKeys,
  secureContentHash,
} from './mule/discover.js';
export * from './input/archive.js';
export * from './input/prepared-source.js';
