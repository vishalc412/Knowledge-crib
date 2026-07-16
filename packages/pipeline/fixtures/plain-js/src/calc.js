// Plain-JS parity fixture (M2.5) — exercises the TS extractor's createSourceFile JS path:
// function declarations, a class with a method, and an intra-file `calls` edge (verify → helper).
// No TypeScript anywhere; the extractor must tag these symbols lang:"javascript".

function helper(n) {
  return n * 2;
}

function verify(value) {
  return helper(value) > 0;
}

class Calculator {
  add(a, b) {
    return helper(a) + b;
  }
}

module.exports = { helper, verify, Calculator };
