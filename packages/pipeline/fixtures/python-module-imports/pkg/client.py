"""Exercises `import M` + `M.f()`, comma multi-module `import a, b`, `from . import x`
(submodule), and multi-part `import a.b` + `a.b.f()` — the module-binding paths (M8 NICE-2/NICE-5).
`use_mismatched` calls `sub.deep()` (chain length != imported module `sub.inner`) which must NOT
resolve to `inner.deep` — a mismatched chain is dropped, never guessed at the wrong file."""
import base, util
from . import helper
import sub.inner


def use_base():
    return base.base_fn()


def use_util():
    return util.util_fn()


def use_helper():
    return helper.do()


def use_deep():
    return sub.inner.deep()


def use_mismatched():
    return sub.deep()