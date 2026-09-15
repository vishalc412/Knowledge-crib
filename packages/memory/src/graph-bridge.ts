/**
 * WP-G2 bridge from graph references to the already-indexed code graph. The bridge deliberately
 * does not create graph nodes: it confirms a symbol id as-is, then tries the canonical file-node
 * spelling for a path. An unresolved target stays unresolved for the caller to report.
 */
export function graphCodeTargetResolver(
  hasCodeNode: (id: string) => boolean,
): (target: string) => string | undefined {
  return (target) => {
    if (hasCodeNode(target)) return target;
    const fileId = `file:${target}`;
    return hasCodeNode(fileId) ? fileId : undefined;
  };
}
