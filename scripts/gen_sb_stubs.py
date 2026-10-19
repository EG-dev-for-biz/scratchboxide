#!/usr/bin/env python3
"""
Generates the type stubs (.pyi) for the scratchbox Python API, and a compact API summary for the in-app agent, from
the live module: what a script sees after `import scratchbox as sb`, with every runtime patch the package applies to
the native classes (scratchbox_native, built from bindings/python_bindings.cpp with nanobind).

Three steps (the analyze -> patch -> generate idea of fake-bpy-module; none of its code):
  1. analyze: import scratchbox and walk the object graph from it. Native callables are read from nanobind's
     __nb_signature__ (every overload, parameter names, defaults, types, docstrings); Python callables from
     inspect.signature. Patched members (a Python function stored on a native class) are read as they are at runtime.
  2. patch: generic repairs for what introspection gets wrong, never a list of types. C++ types nanobind could not
     name become Any; defaults that are not literals become `...`; a class or metaclass with __getattr__ keeps it, so
     names it answers dynamically are not reported missing; an object whose class lists its attributes in __dir__ is
     emitted with exactly those attributes; Python functions without a return annotation get the type basedpyright
     infers from their source (with the native stubs on the path), when that type names only stub types.
  3. generate: one .pyi per module under --out (scratchbox/, scratchbox_native/), plus --summary-ts, a TypeScript
     module with the API summary text and SB_API_VERSION (a hash of the stubs).

Run through `npm run stubs:sb` (builds the native module first); `--check` compares instead of writing.
"""

from __future__ import annotations

import argparse
import ast
import enum
import hashlib
import inspect
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import types
from dataclasses import dataclass, field
from typing import Any

ROOT_PACKAGE = "scratchbox"
NATIVE_PACKAGE = "scratchbox_native"
OWN_ROOTS = (ROOT_PACKAGE, NATIVE_PACKAGE)
BUILTIN_NAMES = set(dir(__import__("builtins")))
# Attributes every class or module carries; they say nothing about the API.
PLUMBING = {
    "__dict__", "__module__", "__doc__", "__weakref__", "__qualname__", "__annotations__", "__slots__",
    "__init_subclass__", "__subclasshook__", "__class_getitem__", "__orig_bases__", "__parameters__",
    "__abstractmethods__", "__firstlineno__", "__static_attributes__", "__match_args__", "__dataclass_fields__",
    "__dataclass_params__", "__hash__", "__reduce__", "__reduce_ex__", "__getstate__", "__setstate__",
    "__sizeof__", "__format__", "__dir__", "__new__", "__nb_signature__", "__getnewargs__",
}
DOC_LINE_MAX = 110


def is_nb_callable(obj: Any) -> bool:
    return hasattr(obj, "__nb_signature__") and type(obj).__name__ in ("nb_func", "nb_method", "nb_bound_method")


def is_nb_type(obj: Any) -> bool:
    return isinstance(obj, type) and type(type(obj)).__name__ == "nb_type" or type(obj).__name__ == "nb_type"


def own_module_name(name: str | None) -> bool:
    return bool(name) and (name == ROOT_PACKAGE or name.startswith(ROOT_PACKAGE + ".") or name == NATIVE_PACKAGE or name.startswith(NATIVE_PACKAGE + "."))


def simple_literal(value: Any) -> str | None:
    """repr of a default value when it is a short literal a stub can carry, else None (the stub writes `...`)."""
    if isinstance(value, float) and value == value and abs(value) != float("inf"):
        short = float(f"{value:.7g}")
        text = repr(short)
        return text if len(text) <= 40 else None
    if value is None or isinstance(value, (bool, int, float, str, bytes)):
        text = repr(value)
        if isinstance(value, float) and not (value == value) or text in ("inf", "-inf"):
            return None
        return text if len(text) <= 40 else None
    if isinstance(value, tuple) and len(value) <= 6:
        parts = [simple_literal(v) for v in value]
        if all(p is not None for p in parts):
            return "(" + ", ".join(parts) + ("," if len(parts) == 1 else "") + ")"
    return None


def own_doc(obj: Any) -> str | None:
    """The object's own docstring (inspect.getdoc would inherit object.__new__'s and the like)."""
    doc = getattr(obj, "__doc__", None)
    return inspect.cleandoc(doc) if isinstance(doc, str) and doc.strip() else None


def first_doc_line(doc: str | None) -> str:
    if not doc:
        return ""
    for line in inspect.cleandoc(doc).splitlines():
        line = line.strip()
        if line:
            line = re.sub(r"\s+", " ", line)
            cut = re.split(r"(?<=[.!?])\s", line, maxsplit=1)[0]
            return cut if len(cut) <= DOC_LINE_MAX else cut[: DOC_LINE_MAX - 1].rstrip() + "…"
    return ""


def docstring_block(doc: str | None, indent: str) -> list[str]:
    if not doc:
        return []
    text = inspect.cleandoc(doc).replace("\\", "\\\\").replace('"""', '\\"\\"\\"').rstrip()
    if not text:
        return []
    lines = text.splitlines()
    if len(lines) == 1:
        return [f'{indent}"""{lines[0]}"""']
    return [f'{indent}"""'] + [f"{indent}{l}" if l.strip() else "" for l in lines] + [f'{indent}"""']


@dataclass
class Signature:
    """One rendered overload: the text between `def name` and the colon, and its parsed parts for the summary."""
    params: str  # "(self, x: float = 1.0)"
    returns: str | None  # "Mesh" or None (unknown)
    doc: str | None = None


@dataclass
class Member:
    name: str
    kind: str  # function | method | staticmethod | classmethod | property | class | alias | value | module
    sigs: list[Signature] = field(default_factory=list)
    doc: str | None = None
    value_type: str | None = None  # property / value type text
    settable: bool = False
    target: str | None = None  # alias / module reference text
    cls: "ClassModel | None" = None
    probe: str | None = None  # source path for return inference (python callables without a return annotation)
    probe_self: str | None = None  # the class a probed function is stored on as a method (probed with a typed self)
    native_return: str | None = None  # return type of the native callable this Python patch replaced


@dataclass
class ClassModel:
    name: str
    qualname: str  # dotted path inside its module
    module: str
    bases: list[str]
    metaclass: str | None
    doc: str | None
    members: list[Member]
    is_enum: bool = False
    enum_members: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class ModuleModel:
    name: str
    doc: str | None
    members: list[Member]
    imports: set[str] = field(default_factory=set)


def instance_attributes(cls: type) -> list[str]:
    """Names a Python class's own methods assign on their first parameter (`self.x = ...`, `self.x: T = ...`)."""
    if type(cls).__name__ == "nb_type":
        return []
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(cls)))
    except (OSError, TypeError, SyntaxError, IndentationError):
        return []
    names: list[str] = []
    cdef = tree.body[0] if tree.body and isinstance(tree.body[0], ast.ClassDef) else None
    if cdef is None:
        return []
    for fn in cdef.body:
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) or not fn.args.args:
            continue
        self_name = fn.args.args[0].arg
        for node in ast.walk(fn):
            targets: list[ast.expr] = []
            if isinstance(node, ast.Assign):
                targets = list(node.targets)
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
                targets = [node.target]
            for t in targets:
                for el in (t.elts if isinstance(t, ast.Tuple) else [t]):
                    if isinstance(el, ast.Attribute) and isinstance(el.value, ast.Name) and el.value.id == self_name and el.attr not in names:
                        names.append(el.attr)
    return names


class Analyzer:
    def __init__(self) -> None:
        # The native callables before the package patches them: a Python patch that replaces one keeps its return
        # type unless the patch declares, or is inferred to return, something more precise.
        import scratchbox_native  # noqa: F401

        pristine: dict[tuple[int, str], Any] = {}
        containers: list[Any] = []
        for name, mod in list(sys.modules.items()):
            if name.startswith(NATIVE_PACKAGE) and isinstance(mod, types.ModuleType):
                containers.append(mod)
                containers += [v for v in vars(mod).values() if isinstance(v, type)]
        for c in containers:
            for k, v in list(vars(c).items()):
                if is_nb_callable(v):
                    pristine[(id(c), k)] = v
        import scratchbox  # noqa: F401  (applies the package's runtime patches to scratchbox_native)

        self.replaced_native: dict[int, Any] = {}
        for c in containers:
            for k, v in list(vars(c).items()):
                orig = pristine.get((id(c), k))
                if orig is not None and v is not orig and inspect.isfunction(v):
                    self.replaced_native.setdefault(id(v), orig)

        self.root = sys.modules[ROOT_PACKAGE]
        self.modules: dict[str, types.ModuleType] = {}
        for name, mod in sorted(sys.modules.items()):
            if own_module_name(name) and isinstance(mod, types.ModuleType):
                self.modules[name] = mod
        # Canonical home of every class reachable from the modules: where its own __module__/__name__ point (when
        # that attribute really is the class), else the first module attribute holding it.
        self.class_home: dict[int, tuple[str, str]] = {}
        for pass_no in (0, 1):
            for mname, mod in self.modules.items():
                for attr in dir(mod):
                    obj = getattr(mod, attr, None)
                    if not isinstance(obj, type) or id(obj) in self.class_home:
                        continue
                    if pass_no == 0 and getattr(obj, "__module__", None) == mname and obj.__name__ == attr:
                        self.class_home[id(obj)] = (mname, attr)
                    elif pass_no == 1 and own_module_name(mname) and own_module_name(getattr(obj, "__module__", "")):
                        self.class_home[id(obj)] = (mname, attr)
        self.extra_classes: dict[str, list[type]] = {}  # private classes a module must emit (types of its instances)
        self.inferred_returns: dict[str, str] = {}
        self.probes: dict[str, str] = {}  # probe expression -> reveal key
        self.patch_log: list[str] = []

    # ---------------------------------------------------------------- references
    def module_of_dotted(self, dotted: str) -> str | None:
        """Longest importable module prefix of a dotted name (`a.b.C` -> `a.b`)."""
        parts = dotted.split(".")
        for i in range(len(parts) - 1, 0, -1):
            cand = ".".join(parts[:i])
            if cand in sys.modules or cand in self.modules:
                return cand
            try:
                __import__(cand)
                return cand
            except Exception:
                continue
        return None

    def class_ref(self, cls: type, current: str, imports: set[str]) -> str:
        if cls is type(None):
            return "None"
        if getattr(cls, "__module__", None) == "builtins":
            return cls.__name__
        home = self.class_home.get(id(cls))
        if home is None:
            mod = getattr(cls, "__module__", None)
            qual = getattr(cls, "__qualname__", cls.__name__)
            if mod and "<locals>" not in qual and not own_module_name(mod):
                imports.add(mod)
                return f"{mod}.{qual}"
            if own_module_name(mod) and "<locals>" not in qual:
                # a nested class: Outer.Inner, homed with its outer class
                outer = getattr(sys.modules.get(mod), qual.split(".")[0], None)
                if isinstance(outer, type) and id(outer) in self.class_home:
                    omod, oname = self.class_home[id(outer)]
                    rest = ".".join(qual.split(".")[1:])
                    if omod == current:
                        return f"{oname}.{rest}"
                    imports.add(omod)
                    return f"{omod}.{oname}.{rest}"
            return "typing.Any" if imports.add("typing") is None else "typing.Any"
        mod, name = home
        if mod == current:
            return name
        imports.add(mod)
        return f"{mod}.{name}"

    def annotation_text(self, ann: Any, fn_globals: dict, current: str, imports: set[str]) -> str | None:
        if ann is inspect.Parameter.empty or ann is inspect.Signature.empty:
            return None
        if isinstance(ann, str):
            text = ann
            try:
                ann = eval(text, dict(fn_globals))  # noqa: S307  (annotations of our own package)
            except Exception:
                # a string naming a type by its module path ("scratchbox_native.geometry.Mesh"), which the defining
                # module need not import: kept when every qualified name in it resolves
                dotted = re.findall(r"\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+", text)
                bare = set(re.findall(r"(?<![\w.])([A-Za-z_]\w*)(?![\w.])", text)) - BUILTIN_NAMES
                if dotted and not bare and all(self.module_of_dotted(d) for d in dotted):
                    return self.rewrite_dotted(text, current, imports)
                return None
        if ann is None or ann is type(None):
            return "None"
        if isinstance(ann, type) and not getattr(ann, "__args__", None) and type(ann).__module__ != "typing":
            return self.class_ref(ann, current, imports)
        text = repr(ann)
        if text.startswith("<"):
            return None
        return self.rewrite_dotted(text, current, imports)

    def rewrite_dotted(self, text: str, current: str, imports: set[str]) -> str | None:
        """Qualified names in a type expression: imports their modules, strips the current module's own prefix,
        turns C++ types nanobind could not name into Any. None when the result is not a valid expression."""
        if "::" in text or re.search(r"\b(std|scratchbox)::", text):
            text = re.sub(r"[A-Za-z_][\w:]*::[\w:]*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?", "typing.Any", text)
            imports.add("typing")
        out = text
        for dotted in sorted(set(re.findall(r"\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+", text)), key=len, reverse=True):
            mod = self.module_of_dotted(dotted)
            if mod is None:
                continue
            if mod == current:
                out = re.sub(rf"(?<![\w.]){re.escape(mod)}\.", "", out)
            elif mod == "builtins":
                out = re.sub(rf"(?<![\w.]){re.escape(mod)}\.", "", out)
            else:
                imports.add(mod)
        try:
            ast.parse(out, mode="eval")
        except SyntaxError:
            return None
        return out

    # ---------------------------------------------------------------- signatures
    def nb_signatures(self, fn: Any, name: str, current: str, imports: set[str], drop_self: bool = False) -> list[Signature]:
        sigs: list[Signature] = []
        for entry in fn.__nb_signature__:
            raw, doc, defaults = entry[0], entry[1], entry[2]
            text = raw[raw.index("def ") :] if "def " in raw else raw
            m = re.match(r"def\s*[\w]*\s*(\(.*\))\s*(?:->\s*(.*))?$", text, re.S)
            if not m:
                self.patch_log.append(f"{current}.{name}: unparsed nanobind signature {raw!r}")
                sigs.append(Signature("(*args, **kwargs)", None, doc))
                continue
            params, ret = m.group(1), (m.group(2) or "").strip() or None

            def default(match: re.Match) -> str:
                lit = simple_literal(defaults[int(match.group(1))]) if defaults else None
                return lit if lit is not None else "..."

            params = re.sub(r"\\(\d+)", default, params)
            params_rw = self.rewrite_dotted(f"lambda_{params}", current, imports)  # validated below as a def
            params = params_rw[len("lambda_") :] if params_rw else params
            params = self.rewrite_params(params, current, imports, name)
            ret_rw = self.rewrite_dotted(ret, current, imports) if ret else None
            if ret and ret_rw is None:
                self.patch_log.append(f"{current}.{name}: return type {ret!r} not expressible; left unannotated")
            sigs.append(Signature(params, ret_rw, doc))
        return sigs

    def rewrite_params(self, params: str, current: str, imports: set[str], name: str) -> str:
        """A parameter list that parses as a def: C++ types -> Any; an unparseable list -> (*args, **kwargs)."""
        if "::" in params:
            params = re.sub(r"[A-Za-z_][\w:]*::[\w:]*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?", "typing.Any", params)
            imports.add("typing")
            self.patch_log.append(f"{current}.{name}: unnamed C++ parameter type replaced by Any")
        try:
            ast.parse(f"def f{params}: ...")
            return params
        except SyntaxError:
            self.patch_log.append(f"{current}.{name}: unparseable parameters {params!r}; accepts anything")
            return "(*args, **kwargs)"

    def py_signature(self, fn: Any, name: str, current: str, imports: set[str], owner: str | None) -> list[Signature]:
        try:
            sig = inspect.signature(fn)
        except (TypeError, ValueError):
            return [Signature("(*args, **kwargs)", None, own_doc(fn))]
        g = getattr(fn, "__globals__", {})
        parts: list[str] = []
        saw_kwonly_marker = False
        last_kind = None
        for p in sig.parameters.values():
            if p.kind == p.POSITIONAL_ONLY:
                pass
            elif last_kind == p.POSITIONAL_ONLY:
                parts.append("/")
            if p.kind == p.KEYWORD_ONLY and not saw_kwonly_marker:
                parts.append("*")
                saw_kwonly_marker = True
            if p.kind == p.VAR_POSITIONAL:
                saw_kwonly_marker = True
            ann = self.annotation_text(p.annotation, g, current, imports)
            piece = ("*" if p.kind == p.VAR_POSITIONAL else "**" if p.kind == p.VAR_KEYWORD else "") + p.name
            if ann:
                piece += f": {ann}"
            if p.default is not p.empty:
                lit = simple_literal(p.default)
                piece += (" = " if ann else "=") + (lit if lit is not None else "...")
            parts.append(piece)
            last_kind = p.kind
        if last_kind == inspect.Parameter.POSITIONAL_ONLY:
            parts.append("/")
        params = self.rewrite_params("(" + ", ".join(parts) + ")", current, imports, name)
        ret = self.annotation_text(sig.return_annotation, g, current, imports)
        return [Signature(params, ret, own_doc(fn))]

    def probe_path(self, fn: Any) -> str | None:
        mod, qual = getattr(fn, "__module__", None), getattr(fn, "__qualname__", "")
        if not own_module_name(mod) or "<locals>" in qual or not qual or mod.startswith(NATIVE_PACKAGE):
            return None
        return f"{mod}.{qual}"

    def callable_member(self, name: str, fn: Any, kind: str, current: str, imports: set[str], owner: type | None = None) -> Member:
        if is_nb_callable(fn):
            return Member(name, kind, self.nb_signatures(fn, name, current, imports), doc=None)
        target = fn.__func__ if isinstance(fn, (staticmethod, classmethod)) else fn
        sigs = self.py_signature(target, name, current, imports, None)
        # `-> Any` says nothing either: the inferred type is used when it is precise
        unknown_return = sigs and sigs[0].returns in (None, "typing.Any")
        probe = self.probe_path(target) if unknown_return else None
        probe_self = None
        if probe and owner is not None and kind == "method" and name != "__init__":
            probe_self = self.class_ref(owner, "", set())
            if probe_self == "typing.Any":
                probe_self = None
        doc = target.__doc__ if isinstance(target.__doc__, str) else None
        native_return = None
        orig = self.replaced_native.get(id(target))
        if orig is not None and unknown_return:
            rets = {s.returns for s in self.nb_signatures(orig, name, current, imports)}
            if len(rets) == 1 and None not in rets:
                native_return = rets.pop()
            doc = doc or next((e[1] for e in orig.__nb_signature__ if e[1]), None)
        return Member(name, kind, sigs, doc=inspect.cleandoc(doc) if doc else None, probe=probe, probe_self=probe_self, native_return=native_return)

    # ---------------------------------------------------------------- classes
    def class_model(self, cls: type, name: str, qualname: str, current: str, imports: set[str]) -> ClassModel:
        bases = []
        for b in cls.__bases__:
            if b is object or type(b).__name__ == "nb_type" and b.__name__ == "object":
                continue
            if issubclass(cls, enum.Enum) and b in (enum.Enum, enum.IntEnum, enum.Flag, enum.IntFlag):
                imports.add("enum")
                bases.append(f"enum.{b.__name__}")
                continue
            bases.append(self.class_ref(b, current, imports))
        meta = type(cls)
        metaclass = None
        if meta not in (type, enum.EnumMeta) and type(meta).__name__ != "nb_type" and meta.__name__ != "nb_type" and not issubclass(cls, enum.Enum):
            metaclass = self.class_ref(meta, current, imports)
            if (id(meta) not in self.class_home or self.class_home[id(meta)][0] != current) and metaclass == "typing.Any":
                metaclass = None
            if metaclass and metaclass != "typing.Any":
                self.require_class(current, meta)
        model = ClassModel(name, qualname, current, bases, metaclass, inspect.getdoc(cls) if cls.__doc__ else None, [])
        if issubclass(cls, enum.Enum):
            model.is_enum = True
            for mname, member in cls.__members__.items():
                lit = simple_literal(member.value)
                model.enum_members.append((mname, lit if lit is not None else "..."))
            return model
        for attr, value in list(cls.__dict__.items()):
            if attr in PLUMBING or (attr.startswith("_") and not attr.startswith("__")):
                if attr != "__new__" or not (inspect.isfunction(value) or isinstance(value, staticmethod)):
                    continue
            m = self.class_member(cls, attr, value, current, imports, f"{qualname}.{attr}")
            if m:
                model.members.append(m)
        # attributes a Python class's methods assign on self (self.height = ...): not in the class __dict__, but real
        known = {m.name for m in model.members} | {a for k in cls.__mro__[1:] for a in vars(k)}
        for name in instance_attributes(cls):
            if name not in known and not name.startswith("_"):
                imports.add("typing")
                model.members.append(Member(name, "value", value_type="typing.Any"))
        return model

    def class_member(self, cls: type, attr: str, value: Any, current: str, imports: set[str], qual: str) -> Member | None:
        dunder = attr.startswith("__") and attr.endswith("__")
        if isinstance(value, property):
            fget = value.fget
            vtype = None
            doc = None
            if fget is not None:
                if is_nb_callable(fget):
                    sig = self.nb_signatures(fget, attr, current, imports)
                    vtype = sig[0].returns if sig else None
                    doc = sig[0].doc if sig else None
                else:
                    sig = self.py_signature(fget, attr, current, imports, None)
                    vtype = sig[0].returns
                    doc = inspect.getdoc(fget)
            m = Member(attr, "property", value_type=vtype, settable=value.fset is not None, doc=doc or (value.__doc__ if not is_nb_callable(fget) else None))
            if vtype is None and fget is not None and not is_nb_callable(fget):
                m.probe = self.probe_path(fget)
            return m
        if type(value).__name__ == "nb_method":
            return self.callable_member(attr, value, "method", current, imports)
        if type(value).__name__ == "nb_func":
            # an nb_func stored on a class does not bind: it is called without self
            return self.callable_member(attr, value, "staticmethod", current, imports)
        if attr == "__new__" and isinstance(value, staticmethod) and inspect.isfunction(value.__func__):
            return self.callable_member(attr, value.__func__, "new", current, imports, owner=cls)
        if isinstance(value, staticmethod):
            inner = value.__func__
            if is_nb_callable(inner):
                return self.callable_member(attr, inner, "staticmethod", current, imports)
            return self.callable_member(attr, value, "staticmethod", current, imports)
        if isinstance(value, classmethod):
            return self.callable_member(attr, value, "classmethod", current, imports)
        if inspect.isfunction(value):
            return self.callable_member(attr, value, "new" if attr == "__new__" else "method", current, imports, owner=cls)
        if dunder:
            return None
        if isinstance(value, type):
            home = self.class_home.get(id(value))
            if home is None and getattr(value, "__qualname__", "") == f"{cls.__qualname__}.{attr}":
                return Member(attr, "class", cls=self.class_model(value, attr, qual, current, imports))
            return Member(attr, "alias", target=self.class_ref(value, current, imports))
        if isinstance(value, types.ModuleType):
            if not own_module_name(value.__name__):
                return None  # a helper module the class happens to hold (math, os): not part of the API
            imports.add(value.__name__)
            return Member(attr, "alias", target=value.__name__)
        return Member(attr, "value", value_type=self.value_type(value, current, imports))

    def value_type(self, value: Any, current: str, imports: set[str]) -> str:
        if value is None:
            return "None"
        t = type(value)
        if t.__module__ == "builtins":
            return t.__name__
        if own_module_name(t.__module__):
            self.require_class(t.__module__, t)
            return self.class_ref(t, current, imports)
        imports.add("typing")
        return "typing.Any"

    def require_class(self, module: str, cls: type) -> None:
        """A class the stubs need although no public attribute names it (the type of a module-level instance such as
        `layout = _LayoutModule()`, or a metaclass): emitted in its home module."""
        if id(cls) in self.class_home:
            home_mod, home_name = self.class_home[id(cls)]
            if not home_name.startswith("_"):
                return  # emitted as that module's public class
        else:
            home_mod = cls.__module__ if cls.__module__ in self.modules else module
            home_name = cls.__name__
            self.class_home[id(cls)] = (home_mod, home_name)
        if all(c is not cls for c in self.extra_classes.get(home_mod, [])):
            self.extra_classes.setdefault(home_mod, []).append(cls)

    # ---------------------------------------------------------------- modules
    def module_model(self, mname: str) -> ModuleModel:
        mod = self.modules[mname]
        imports: set[str] = set()
        members: list[Member] = []
        for attr in dir(mod):
            if attr.startswith("_") or attr in PLUMBING:
                continue
            value = getattr(mod, attr)
            m = self.module_member(mname, attr, value, imports)
            if m:
                members.append(m)
        return ModuleModel(mname, mod.__doc__, members, imports)

    def module_member(self, mname: str, attr: str, value: Any, imports: set[str]) -> Member | None:
        if isinstance(value, types.ModuleType):
            return Member(attr, "module", target=value.__name__)
        if isinstance(value, type):
            home = self.class_home.get(id(value))
            if home == (mname, attr):
                return Member(attr, "class", cls=self.class_model(value, attr, attr, mname, imports))
            return Member(attr, "alias", target=self.class_ref(value, mname, imports))
        if getattr(type(value), "__module__", None) == "typing" or getattr(value, "__module__", None) == "typing":
            imports.add("typing")
            return Member(attr, "alias", target=f"typing.{attr}" if hasattr(__import__("typing"), attr) else "typing.Any")
        if is_nb_callable(value) or inspect.isfunction(value) or inspect.ismethod(value) or isinstance(value, (types.BuiltinFunctionType,)):
            return self.callable_member(attr, value, "function", mname, imports)
        if callable(value) and not isinstance(value, type) and hasattr(type(value), "__call__") and not own_module_name(type(value).__module__):
            imports.add("typing")
            return Member(attr, "value", value_type="typing.Any")
        cls = type(value)
        if own_module_name(cls.__module__) and "__dir__" in cls.__dict__ and "__getattr__" in cls.__dict__:
            # a namespace object whose class lists its attributes in __dir__: exactly those attributes
            return Member(attr, "value", value_type=self.namespace_class(mname, attr, value, imports))
        return Member(attr, "value", value_type=self.value_type(value, mname, imports))

    def namespace_class(self, mname: str, attr: str, value: Any, imports: set[str]) -> str:
        cname = f"_{attr}_namespace"
        model = ClassModel(cname, cname, mname, [], None, inspect.getdoc(type(value)), [])
        for name in sorted(dir(value)):
            if name.startswith("_"):
                continue
            try:
                v = getattr(value, name)
            except Exception:
                continue
            if isinstance(v, types.ModuleType):
                if own_module_name(v.__name__):
                    imports.add(v.__name__)
                    model.members.append(Member(name, "alias", target=v.__name__))
            elif isinstance(v, type):
                model.members.append(Member(name, "alias", target=self.class_ref(v, mname, imports)))
            elif is_nb_callable(v) or inspect.isfunction(v) or inspect.ismethod(v):
                model.members.append(self.callable_member(name, v, "staticmethod", mname, imports))
            elif getattr(type(v), "__module__", None) == "typing" or getattr(v, "__module__", None) == "typing":
                continue
            else:
                model.members.append(Member(name, "value", value_type=self.value_type(v, mname, imports)))
        self.synthetic.setdefault(mname, []).append(model)
        return cname

    synthetic: dict[str, list[ClassModel]]

    def analyze(self) -> dict[str, ModuleModel]:
        self.synthetic = {}
        models = {name: self.module_model(name) for name in self.modules}
        # private classes found while walking (types of module-level instances, metaclasses)
        changed = True
        emitted: set[int] = set()
        while changed:
            changed = False
            for mname, classes in list(self.extra_classes.items()):
                for cls in list(classes):
                    if id(cls) in emitted:
                        continue
                    emitted.add(id(cls))
                    changed = True
                    model = models[mname]
                    home_name = self.class_home[id(cls)][1]
                    model.members.append(Member(home_name, "class", cls=self.class_model(cls, home_name, home_name, mname, model.imports)))
        for mname, classes in self.synthetic.items():
            for c in classes:
                models[mname].members.append(Member(c.name, "class", cls=c))
        return models


# -------------------------------------------------------------------- rendering
def render_def(name: str, sig: Signature, indent: str, decorators: list[str], with_doc: bool) -> list[str]:
    ret = f" -> {sig.returns}" if sig.returns else ""
    head = [f"{indent}{d}" for d in decorators] + [f"{indent}def {name}{sig.params}{ret}:"]
    doc = docstring_block(sig.doc, indent + "    ") if with_doc else []
    if doc:
        return head + doc
    head[-1] += " ..."
    return head


def render_callable(m: Member, indent: str) -> list[str]:
    out: list[str] = []
    deco = {"staticmethod": ["@staticmethod"], "classmethod": ["@classmethod"]}.get(m.kind, [])
    overloaded = len(m.sigs) > 1
    for sig in m.sigs:
        if sig.doc is None and not overloaded:
            sig = Signature(sig.params, sig.returns, m.doc)
        if overloaded:
            deco_all = deco + ["@typing.overload"]
        else:
            deco_all = deco
        out += render_def(m.name, sig, indent, deco_all, True)
        out.append("")
    return out


def render_class(c: ClassModel, indent: str) -> list[str]:
    bases = list(c.bases)
    if c.metaclass:
        bases.append(f"metaclass={c.metaclass}")
    head = f"{indent}class {c.name}" + (f"({', '.join(bases)})" if bases else "") + ":"
    body: list[str] = []
    inner = indent + "    "
    body += docstring_block(c.doc, inner)
    if c.is_enum:
        body += [f"{inner}{n} = {v}" for n, v in c.enum_members]
    for m in c.members:
        if m.kind in ("method", "staticmethod", "classmethod", "function", "new"):
            body += render_callable(m, inner)
        elif m.kind == "property":
            body.append(f"{inner}@property")
            body.append(f"{inner}def {m.name}(self)" + (f" -> {m.value_type}" if m.value_type else "") + ":" + ("" if m.doc else " ..."))
            body += docstring_block(m.doc, inner + "    ")
            if m.settable:
                body.append(f"{inner}@{m.name}.setter")
                body.append(f"{inner}def {m.name}(self, value" + (f": {m.value_type}" if m.value_type else "") + ") -> None: ...")
            body.append("")
        elif m.kind == "class" and m.cls:
            body += render_class(m.cls, inner)
        elif m.kind == "alias":
            body.append(f"{inner}{m.name} = {m.target}")
        elif m.kind == "value":
            body.append(f"{inner}{m.name}: {m.value_type}")
    while body and body[-1] == "":
        body.pop()
    if not body:
        body = [f"{inner}..."]
    return [head] + body + [""]


def render_module(model: ModuleModel, uses_overload: bool) -> str:
    lines: list[str] = []
    lines += docstring_block(model.doc, "")
    body: list[str] = []
    imports = set(model.imports)
    for m in model.members:
        if m.kind == "module":
            body.append(f"import {m.target} as {m.name}" if m.target != m.name else f"import {m.target}")
        elif m.kind == "alias":
            body.append(f"{m.name} = {m.target}")
        elif m.kind == "value":
            body.append(f"{m.name}: {m.value_type}")
        elif m.kind == "class" and m.cls:
            body += [""] + render_class(m.cls, "")
        else:
            body += [""] + render_callable(m, "")
    public = sorted({m.name for m in model.members if not m.name.startswith("_")})
    if public:
        body = [f"__all__ = {public!r}", ""] + body
    text_body = "\n".join(body)
    if "typing." in text_body:
        imports.add("typing")
    imports.discard(model.name)
    import_lines = []
    for imp in sorted(imports):
        if imp == "builtins":
            continue
        import_lines.append(f"import {imp}")
    out = "\n".join(lines + ([""] if lines else []) + import_lines + [""] + [text_body])
    out = re.sub(r"\n{3,}", "\n\n\n", out).strip() + "\n"
    return out


def stub_path(out_dir: str, module: str, is_package: bool) -> str:
    parts = module.split(".")
    if is_package:
        return os.path.join(out_dir, *parts, "__init__.pyi")
    return os.path.join(out_dir, *parts[:-1], parts[-1] + ".pyi")


def write_stubs(out_dir: str, models: dict[str, ModuleModel]) -> dict[str, str]:
    files: dict[str, str] = {}
    packages = {name for name in models if any(o.startswith(name + ".") for o in models)} | set(OWN_ROOTS)
    for name, model in models.items():
        path = stub_path(out_dir, name, name in packages)
        files[path] = render_module(model, True)
    for path, text in files.items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    return files


# -------------------------------------------------------------------- return inference (patch step)
def basedpyright_bin() -> str:
    cand = os.path.join(os.path.dirname(sys.executable), "basedpyright")
    if os.path.exists(cand):
        return cand
    found = shutil.which("basedpyright")
    if not found:
        raise SystemExit(f"basedpyright is not installed in {sys.executable}'s environment: run `{sys.executable} -m pip install -r requirements.txt`")
    return found


def probe_expr(m: Member) -> str:
    """A function's return type: revealed from its type, or, for a function stored on a class as a method, from a call
    with a typed self (pyright then infers the body for that receiver, e.g. a patch that returns self)."""
    if m.probe_self:
        return f"{m.probe}(typing.cast({m.probe_self!r}, None), *typing.cast(typing.Any, ()), **typing.cast(typing.Any, {{}}))"
    return m.probe or ""


def collect_probes(models: dict[str, ModuleModel]) -> list[str]:
    probes: set[str] = set()

    def visit(members: list[Member]) -> None:
        for m in members:
            if m.probe:
                probes.add(probe_expr(m))
            if m.cls:
                visit(m.cls.members)

    for model in models.values():
        visit(model.members)
    return sorted(probes)


def infer_returns(probes: list[str], native_stub_dir: str, python_root: str) -> dict[str, str]:
    """Return types basedpyright infers for unannotated Python callables, read from their source with the native
    stubs on the path. Keyed by probe path; the value is pyright's printed return type."""
    if not probes:
        return {}
    with tempfile.TemporaryDirectory(prefix="sb_probe_") as tmp:
        # the package's .py sources only: a .pyi next to them would shadow the code being read
        src_root = os.path.join(tmp, "src")
        pkg_dir = os.path.join(python_root, ROOT_PACKAGE)
        for dirpath, _dirs, filenames in os.walk(pkg_dir):
            for fn in filenames:
                if fn.endswith(".py"):
                    rel = os.path.relpath(os.path.join(dirpath, fn), python_root)
                    os.makedirs(os.path.dirname(os.path.join(src_root, rel)), exist_ok=True)
                    shutil.copyfile(os.path.join(dirpath, fn), os.path.join(src_root, rel))
        dotted = set()
        for p in probes:
            dotted.update(re.findall(r"[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+", p))
        lines = ["import typing"]
        for d in sorted(dotted):
            m = d
            while m and m not in sys.modules:
                m = m.rsplit(".", 1)[0] if "." in m else ""
            if m:
                lines.append(f"import {m}")
        for i, p in enumerate(probes):
            lines.append(f"reveal_type({p})  # probe:{i}")
        src = os.path.join(tmp, "probe.py")
        with open(src, "w") as fh:
            fh.write("\n".join(sorted(set(l for l in lines if l.startswith("import")))) + "\n" + "\n".join(l for l in lines if not l.startswith("import")) + "\n")
        cfg = {
            "extraPaths": [native_stub_dir, src_root],
            "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}",
            "typeCheckingMode": "standard",
            "pythonPath": sys.executable,
            "reportMissingModuleSource": False,
        }
        with open(os.path.join(tmp, "pyrightconfig.json"), "w") as fh:
            json.dump(cfg, fh)
        proc = subprocess.run([basedpyright_bin(), "--outputjson", "-p", os.path.join(tmp, "pyrightconfig.json"), src], capture_output=True, text=True, cwd=tmp, timeout=600)
        try:
            report = json.loads(proc.stdout)
        except json.JSONDecodeError:
            raise SystemExit(f"basedpyright produced no report: {proc.stderr[-2000:]}")
        by_line: dict[int, str] = {}
        for d in report.get("generalDiagnostics", []):
            msg = d.get("message", "")
            mm = re.match(r'Type of "(.+)" is "(.*)"$', msg, re.S)
            if mm:
                by_line[d["range"]["start"]["line"]] = mm.group(2)
        out: dict[str, str] = {}
        with open(src) as fh:
            for idx, line in enumerate(fh.read().splitlines()):
                pm = re.search(r"# probe:(\d+)$", line)
                if pm and idx in by_line:
                    out[probes[int(pm.group(1))]] = by_line[idx]
        return out


def split_return(type_text: str) -> str | None:
    """The return part of a printed callable type `(a: int) -> Mesh`; None when it is not a single callable."""
    depth = 0
    pos = -1
    i = 0
    while i < len(type_text):
        c = type_text[i]
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif type_text.startswith("->", i) and depth == 0:
            pos = i
        i += 1
    if pos < 0 or type_text.startswith("Overload["):
        return None
    return type_text[pos + 2 :].strip()


def map_printed_type(text: str, class_names: dict[str, list[str]], current: str, imports: set[str], owner: str | None) -> str | None:
    """pyright prints short names (Mesh, list[Vec3], Self@World); a type is kept only when every name resolves to
    exactly one stub class or a builtin, else the callable stays unannotated (Unknown, never a false error)."""
    text = re.sub(r"Self@(\w+)", r"\1", text)
    if "Unknown" in text or "Module(" in text or "<" in text or "@" in text or "..." in text or "*" in text:
        return None
    allowed = {"None", "int", "float", "str", "bool", "bytes", "bytearray", "list", "dict", "tuple", "set", "frozenset", "object", "type", "complex", "Literal", "Any", "True", "False"}
    out = text
    for ident in sorted(set(re.findall(r"(?<![\w.'\"])([A-Za-z_]\w*)(?![\w'\"])", text)), key=len, reverse=True):
        if ident in allowed:
            if ident in ("Literal", "Any"):
                out = re.sub(rf"(?<![\w.]){ident}\b", f"typing.{ident}", out)
                imports.add("typing")
            continue
        homes = class_names.get(ident, [])
        if len(homes) != 1:
            return None
        mod, qual = homes[0].rsplit(":", 1)
        ref = qual if mod == current else f"{mod}.{qual}"
        if mod != current:
            imports.add(mod)
        out = re.sub(rf"(?<![\w.]){ident}\b", ref, out)
    try:
        ast.parse(out, mode="eval")
    except SyntaxError:
        return None
    return out


def apply_inferred(models: dict[str, ModuleModel], inferred: dict[str, str]) -> int:
    class_names: dict[str, list[str]] = {}

    def index(members: list[Member], mod: str, prefix: str) -> None:
        for m in members:
            if m.kind == "class" and m.cls:
                q = f"{prefix}{m.cls.name}"
                class_names.setdefault(m.cls.name, []).append(f"{mod}:{q}")
                index(m.cls.members, mod, q + ".")

    for name, model in models.items():
        index(model.members, name, "")
    # one name may be homed in several modules only when it is one class; prefer its native/defining home
    applied = 0

    def visit(members: list[Member], mod: str, imports: set[str]) -> None:
        nonlocal applied
        for m in members:
            if m.cls:
                visit(m.cls.members, mod, imports)
            key = probe_expr(m) if m.probe else None
            if not key or key not in inferred:
                continue
            printed = inferred[key]
            ret_text = printed if (m.kind == "property" or m.probe_self) else split_return(printed)
            if ret_text is None:
                continue
            mapped = map_printed_type(ret_text, class_names, mod, imports, None)
            if mapped is None or "typing.Any" in mapped:
                continue
            if m.kind == "property":
                m.value_type = mapped
            else:
                m.sigs = [Signature(s.params, mapped, s.doc) for s in m.sigs]
            applied += 1

    for name, model in models.items():
        visit(model.members, name, model.imports)

    def native_fallback(members: list[Member]) -> None:
        for m in members:
            if m.cls:
                native_fallback(m.cls.members)
            if m.native_return and m.sigs and all(s.returns in (None, "typing.Any") for s in m.sigs):
                m.sigs = [Signature(s.params, m.native_return, s.doc) for s in m.sigs]

    for model in models.values():
        native_fallback(model.members)
    return applied


# -------------------------------------------------------------------- API summary
def compact_type(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"\b(?:[A-Za-z_]\w*\.)+([A-Za-z_]\w*)", r"\1", text)


MAX_SUMMARY_PARAMS = 8


def compact_params(params: str, max_params: int = MAX_SUMMARY_PARAMS) -> str:
    """`(self, radius: float = 1.0, *, segments: int = 24)` -> `(radius=1.0, *, segments=24)`: names and defaults
    only (the stubs carry the types), at most MAX_SUMMARY_PARAMS parameters."""
    try:
        fn = ast.parse(f"def f{params}: ...").body[0]
    except SyntaxError:
        return compact_type(params)
    a = fn.args  # type: ignore[attr-defined]
    out: list[str] = []
    positional = a.posonlyargs + a.args
    defaults = [None] * (len(positional) - len(a.defaults)) + list(a.defaults)
    for i, (arg, d) in enumerate(zip(positional, defaults)):
        if i == 0 and arg.arg in ("self", "cls"):
            continue
        out.append(arg.arg + (f"={ast.unparse(d)}" if d is not None else ""))
    if a.vararg:
        out.append(f"*{a.vararg.arg}")
    elif a.kwonlyargs:
        out.append("*")
    for arg, d in zip(a.kwonlyargs, a.kw_defaults):
        out.append(arg.arg + (f"={ast.unparse(d)}" if d is not None else ""))
    if a.kwarg:
        out.append(f"**{a.kwarg.arg}")
    if len(out) > max_params:
        out = out[:max_params] + ["…"]
    return "(" + ", ".join(out) + ")"


def summary_entries(models: dict[str, ModuleModel], max_params: int = MAX_SUMMARY_PARAMS) -> list[tuple[str, list[str]]]:
    """(heading, lines) blocks in priority order: sb's own functions; then classes, most referenced first (returned
    by more callables, aliased on sb); then the functions of the namespaces on sb (sb.geometry, sb.layout, ...)."""
    root = models[ROOT_PACKAGE]
    classes: dict[str, ClassModel] = {}

    def index(members: list[Member], mod: str, prefix: str) -> None:
        for m in members:
            if m.kind == "class" and m.cls:
                classes[f"{mod}.{prefix}{m.cls.name}"] = m.cls
                index(m.cls.members, mod, f"{prefix}{m.cls.name}.")

    for name, model in models.items():
        index(model.members, name, "")

    # module-level aliases of classes (geometry.PbrMaterial = scratchbox.PbrMaterial, sb.Scene = World)
    aliases: dict[str, str] = {}
    for name, model in models.items():
        for m in model.members:
            if m.kind == "alias" and m.target:
                aliases[f"{name}.{m.name}"] = m.target if "." in m.target else f"{name}.{m.target}"

    def resolve_class(ref: str | None, mod: str) -> str | None:
        if not ref:
            return None
        for cand in (ref, f"{mod}.{ref}"):
            for _ in range(5):
                if cand in classes:
                    return cand
                if cand not in aliases:
                    break
                cand = aliases[cand]
        return None

    def sig_line(prefix: str, name: str, s: Signature, doc_fallback: str | None) -> str:
        doc = first_doc_line(s.doc or doc_fallback)
        ret = f" -> {compact_type(s.returns)}" if s.returns and s.returns != "None" else ""
        return f"  {prefix}{name}{compact_params(s.params, max_params)}{ret}" + (f"  # {doc}" if doc else "")

    def callable_lines(m: Member, prefix: str) -> list[str]:
        return [sig_line(prefix, m.name, s, m.doc) for s in m.sigs[:2]]

    # how often each class is referenced: returned by a callable, a property's type, or named on sb
    refs: dict[str, int] = {}

    def count(members: list[Member], mod: str, owner: str | None = None) -> None:
        for m in members:
            for s in m.sigs:
                # returned (weight 2) or taken as a parameter (weight 1)
                for text, weight in ((s.returns or "", 2), (s.params, 1)):
                    for nm in set(re.findall(r"[A-Za-z_][\w.]*", text)):
                        c = resolve_class(nm, mod)
                        if c and c != owner:  # a class's own methods returning it say nothing about its reach
                            refs[c] = refs.get(c, 0) + weight
            if m.kind == "property":
                c = resolve_class(m.value_type, mod)
                if c:
                    refs[c] = refs.get(c, 0) + 1
            if m.cls:
                count(m.cls.members, mod, f"{mod}.{m.cls.qualname}")

    for name, model in models.items():
        count(model.members, name)
    labels: dict[str, str] = {}
    for m in root.members:
        target = None
        if m.kind == "class" and m.cls:
            target = f"{ROOT_PACKAGE}.{m.name}"
        elif m.kind in ("alias", "value"):
            target = resolve_class(m.target or m.value_type, ROOT_PACKAGE)
        if target:
            refs[target] = refs.get(target, 0) + 3
            labels.setdefault(target, f"sb.{m.name}")

    def display(path: str) -> str:
        if path in labels:
            return labels[path]
        mod, _, rest = path.partition(".")
        sub = path.split(".")
        for i in range(len(sub) - 1, 0, -1):
            modname = ".".join(sub[:i])
            if modname in models:
                short = modname.replace(NATIVE_PACKAGE, "sb", 1).replace(ROOT_PACKAGE, "sb", 1)
                return f"{short}.{'.'.join(sub[i:])}"
        return path

    blocks: list[tuple[str, list[str]]] = []
    blocks.append(("sb functions (import scratchbox as sb)", [l for m in root.members if m.kind == "function" for l in callable_lines(m, "sb.")]))

    def class_lines(path: str, c: ClassModel) -> list[str]:
        lines: list[str] = []
        props = [m for m in c.members if m.kind == "property"]
        values = [m for m in c.members if m.kind in ("value", "alias") and not m.name.startswith("_")]
        if c.is_enum:
            lines.append("  values: " + ", ".join(n for n, _ in c.enum_members))
        if props or values:
            lines.append("  attributes: " + ", ".join(
                [p.name + (f": {compact_type(p.value_type)}" if p.value_type else "") + ("" if p.settable else " (read-only)") for p in props]
                + [v.name for v in values]))
        for m in c.members:
            if m.kind == "new" or m.name == "__init__":
                lines += [sig_line("", display(path), s, m.doc) for s in m.sigs[:2]]
            elif m.kind in ("method", "staticmethod", "classmethod") and not m.name.startswith("_"):
                lines += callable_lines(m, "." if m.kind == "method" else f"{c.name}.")
            elif m.kind == "class" and m.cls:
                lines.append(f"  {c.name}.{m.cls.name}: class (see below)")
        if c.metaclass:
            lines.append("  (other attribute names are answered dynamically)")
        return lines

    order = sorted(classes, key=lambda p: (-refs.get(p, 0), display(p)))
    for path in order:
        if refs.get(path, 0) == 0:
            continue
        blocks.append((f"{display(path)}", class_lines(path, classes[path])))
    for m in root.members:
        if m.kind == "module" and m.target in models:
            sub = models[m.target]
            lines = [l for sm in sub.members if sm.kind == "function" for l in callable_lines(sm, f"sb.{m.name}.")]
            if lines:
                blocks.append((f"sb.{m.name} functions", lines))
    for path in order:
        if refs.get(path, 0) == 0:
            blocks.append((f"{display(path)}", class_lines(path, classes[path])))
    return blocks


def build_summary(models: dict[str, ModuleModel], budget_tokens: int, version: str, with_docs: bool = True) -> str:
    """The blocks of summary_entries within the budget (about 4 characters per token). Lines are given out in two
    passes: first each block in priority order gets a share that falls with its rank, then the remaining budget goes
    to the blocks in order, so a small budget still shows the start of the important blocks. Blocks left out entirely
    are named at the end."""
    budget = budget_tokens * 4
    head = (f"scratchbox API (generated from the engine's stubs, version {version}; parameter names and defaults, "
            "-> return type" + (", # first doc line" if with_docs else "") + "). Scripts are type-checked against these "
            "stubs before they run: an attribute, function or keyword that is not in the API is rejected without running.\n")
    def dense(line: str) -> str:
        # no doc, no indentation, no repeated `sb.x.` / `.` prefix (the block heading names it)
        line = re.sub(r"  # .*$", "", line).strip()
        return re.sub(r"^(?:sb\.(?:[A-Za-z_]\w*\.)*|\.)(?=[A-Za-z_]\w*\()", "", line)

    blocks = [(h, [l if with_docs else dense(l) for l in lines]) for h, lines in summary_entries(models, MAX_SUMMARY_PARAMS if with_docs else 5) if lines]
    reserve = 300  # room for the list of omitted blocks
    used = len(head)
    kept: list[list[str]] = [[] for _ in blocks]
    # first pass: a share that falls with the block's rank (60, 30, 20, 15, ... lines, at least 4); second pass: the rest
    for first_pass in (True, False):
        for i, (heading, lines) in enumerate(blocks):
            quota = max(4, 60 // (i + 1)) if first_pass else None
            for l in lines[len(kept[i]):]:
                if quota is not None and len(kept[i]) >= quota:
                    break
                cost = len(l) + 1 + (len(heading) + 2 if not kept[i] else 0)
                if used + cost > budget - reserve:
                    break
                kept[i].append(l)
                used += cost
    out = [head]
    omitted: list[str] = []
    for (heading, lines), k in zip(blocks, kept):
        if not k:
            omitted.append(heading)
            continue
        more = f" (+{len(lines) - len(k)} more)" if len(k) < len(lines) else ""
        if with_docs:
            out.append(f"{heading}:")
            out += k
            if more:
                out.append(f" {more}")
        else:
            out.append(f"{heading}: " + "; ".join(k) + more)
    if omitted:
        tail = "Also in the API (not listed here): "
        room = budget - sum(len(l) + 1 for l in out)
        names = []
        for name in omitted:
            if len(tail) + sum(len(n) + 2 for n in names) + len(name) + 4 > room:
                names.append("…")
                break
            names.append(name)
        out.append(tail + "; ".join(names))
    return "\n".join(out).rstrip() + "\n"


def api_index(models: dict[str, ModuleModel]) -> dict[str, list[str]]:
    index: dict[str, set[str]] = {}

    def visit_class(c: ClassModel) -> None:
        names = index.setdefault(c.name, set())
        names.update(m.name for m in c.members if not (m.name.startswith("__") and m.name.endswith("__")))
        names.update(n for n, _ in c.enum_members)
        for m in c.members:
            if m.cls:
                visit_class(m.cls)

    for name, model in models.items():
        index.setdefault(name, set()).update(m.name for m in model.members if not m.name.startswith("_"))
        for m in model.members:
            if m.cls:
                visit_class(m.cls)
    return {k: sorted(v) for k, v in index.items()}


def ts_string(text: str) -> str:
    return "`" + text.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${") + "`"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="stub directory (gets scratchbox/ and scratchbox_native/)")
    ap.add_argument("--summary-ts", required=True, help="TypeScript module to write the API summary and version to")
    ap.add_argument("--full-budget", type=int, default=3500, help="token budget of the full summary")
    ap.add_argument("--core-budget", type=int, default=1800, help="token budget of the core summary (tool description)")
    args = ap.parse_args()

    analyzer = Analyzer()
    models = analyzer.analyze()
    out_dir = os.path.abspath(args.out)
    if os.path.isdir(out_dir):
        for sub in OWN_ROOTS:
            shutil.rmtree(os.path.join(out_dir, sub), ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)

    # pass 1: stubs without inferred returns; the native ones let basedpyright read the Python sources
    with tempfile.TemporaryDirectory(prefix="sb_native_stubs_") as native_tmp:
        write_stubs(native_tmp, {k: v for k, v in models.items() if k.startswith(NATIVE_PACKAGE)})
        python_root = os.path.dirname(os.path.dirname(sys.modules[ROOT_PACKAGE].__file__))
        inferred = infer_returns(collect_probes(models), native_tmp, python_root)
    applied = apply_inferred(models, inferred)
    if os.environ.get("SB_STUBS_DEBUG"):
        for k, v in sorted(inferred.items()):
            print("INFER", k, "=>", v, file=sys.stderr)
    files = write_stubs(out_dir, models)

    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(os.path.relpath(path, out_dir).replace(os.sep, "/").encode())
        digest.update(files[path].encode())
    version = digest.hexdigest()[:12]
    full = build_summary(models, args.full_budget, version)
    core = build_summary(models, args.core_budget, version, with_docs=False)
    ts = (
        "// GENERATED by scripts/gen_sb_stubs.py (npm run stubs:sb) from the live scratchbox module. Do not edit;\n"
        "// packages/core/test/sb-stubs.test.ts fails when this file or the stubs in packages/core/src/python/typings differ\n"
        "// from a fresh generation.\n\n"
        "/** Hash of the generated stubs: the scratchbox API version a script was checked against. */\n"
        f"export const SB_API_VERSION = '{version}';\n\n"
        "/** The API reference (module -> class -> signatures, one-line docs), within the full token budget. */\n"
        f"export const SB_API_SUMMARY = {ts_string(full)};\n\n"
        "/** The same reference within the small budget used in the execute_3d_python_script description. */\n"
        f"export const SB_API_CORE_SUMMARY = {ts_string(core)};\n\n"
        "/** Names each module and class of the stubs defines (classes by their short name), for the type-check gate's\n"
        " *  \"did you mean\" hints and to tell scratchbox types from others in a diagnostic. */\n"
        f"export const SB_API_INDEX: Record<string, readonly string[]> = {json.dumps(api_index(models), indent=4, sort_keys=True)};\n"
    )
    os.makedirs(os.path.dirname(os.path.abspath(args.summary_ts)), exist_ok=True)
    with open(args.summary_ts, "w", encoding="utf-8") as fh:
        fh.write(ts)
    unknown: list[str] = []

    def list_unknown(members: list[Member], prefix: str) -> None:
        for m in members:
            if m.cls:
                list_unknown(m.cls.members, f"{prefix}{m.cls.name}.")
            if m.probe and m.kind not in ("new",) and m.name != "__init__" and not m.name.startswith("__"):
                if (m.kind == "property" and not m.value_type) or (m.kind != "property" and all(s.returns in (None, "typing.Any") for s in m.sigs)):
                    unknown.append(f"{prefix}{m.name}")

    for name, model in models.items():
        list_unknown(model.members, f"{name}.")
    print(json.dumps({
        "unknownReturns": unknown,
        "version": version,
        "stubFiles": len(files),
        "probes": len(collect_probes(models)),
        "inferredReturnsApplied": applied,
        "fullSummaryChars": len(full),
        "coreSummaryChars": len(core),
        "patches": analyzer.patch_log,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
