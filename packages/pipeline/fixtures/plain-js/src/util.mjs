// MJS parity fixture (M2.5) — ESM module. The extractor must admit .mjs (ScriptKind.JS) and
// surface the format function symbol tagged lang:"javascript".

export function format(value) {
  return String(value).toUpperCase();
}

export const VERSION = '1.0.0';
