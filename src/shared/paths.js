// Pure path-walking helper. No Node APIs — shared by CLI and browser preview.

// Resolves a possibly-dotted field path against an object (0.6.1).
// A flat key wins over a dotted walk, so data that literally contains a
// "metadata.sessionId" column stays addressable; otherwise the path is
// walked one segment at a time. Returns undefined when any segment is
// missing or a non-object is hit mid-path.
export function getByPath(obj, path) {
  if (obj == null || typeof path !== 'string' || path.length === 0) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  if (!path.includes('.')) return undefined;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}
