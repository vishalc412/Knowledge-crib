// CJS parity fixture (M2.5) — CommonJS module. The extractor must admit .cjs (ScriptKind.JS) and
// surface the parse function symbol tagged lang:"javascript".

function parse(input) {
  return Number.parseInt(input, 10);
}

module.exports = { parse };
