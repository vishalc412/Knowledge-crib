/**
 * Extractor registry: priority-ordered; first `supports()` match wins (extractor-plugins §3).
 * A registry instance is created per pipeline run so tests stay isolated.
 */
import type { Extractor, FileMeta } from './types.js';

export class ExtractorRegistry {
  private readonly extractors: Extractor[] = [];

  register(extractor: Extractor): this {
    this.extractors.push(extractor);
    return this;
  }

  /** First registered extractor whose supports() returns true, or undefined. */
  resolve(file: FileMeta): Extractor | undefined {
    return this.extractors.find((e) => e.supports(file));
  }

  all(): readonly Extractor[] {
    return this.extractors;
  }
}
