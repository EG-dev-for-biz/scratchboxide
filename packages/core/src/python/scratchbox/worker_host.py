#!/usr/bin/env python3
"""Persistent worker host for Scratchbox's Python sidecar scripts.

    python -u worker_host.py <target_script.py>

Imports the target script ONCE (so anything it caches at module level, such as a loaded model, stays loaded)
and then serves requests on stdin, one JSON object per line:

    {"id": 7, "argv": ["--input", "a.png"], "stdin": "optional text", "cwd": "/optional/dir"}

Each request runs the script's ``main()`` as if it had been started as ``target_script.py <argv...>``: sys.argv
is set, sys.stdin reads the request's ``stdin`` text (empty when none), and what the script prints to
sys.stdout / sys.stderr is captured. ``sys.exit(n)`` ends the request, not the worker. The answer is one line:

    {"id": 7, "exitCode": 0, "stdout": "...", "stderr": "..."}

An uncaught exception answers exitCode 1 with the traceback in stderr. Requests are served one at a time; the
Node side runs several host processes for parallelism. The protocol uses private copies of the original
stdin/stdout descriptors, and fd 1 is pointed at stderr, so native libraries that write to fd 1 cannot corrupt
the protocol stream. The host exits when stdin closes (the parent went away) or on {"shutdown": true}.
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import traceback


def _load_target(script_path):
    script_dir = os.path.dirname(os.path.abspath(script_path))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    # Explicit source loader: the target is imported as Python whatever its file name ends with.
    loader = importlib.machinery.SourceFileLoader("sb_worker_target", script_path)
    spec = importlib.util.spec_from_loader("sb_worker_target", loader)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["sb_worker_target"] = module
    spec.loader.exec_module(module)
    if not callable(getattr(module, "main", None)):
        raise RuntimeError(f"{script_path} defines no main() for the worker host to call")
    return module


def _serve_one(module, script_path, request):
    argv = request.get("argv") or []
    stdin_text = request.get("stdin") or ""
    cwd = request.get("cwd")
    out, err = io.StringIO(), io.StringIO()
    saved = (sys.argv, sys.stdin, sys.stdout, sys.stderr, os.getcwd())
    exit_code = 0
    try:
        if cwd:
            os.chdir(cwd)
        sys.argv = [script_path] + [str(a) for a in argv]
        sys.stdin = io.TextIOWrapper(io.BytesIO(stdin_text.encode("utf-8")), encoding="utf-8")
        sys.stdout, sys.stderr = out, err
        try:
            module.main()
        except SystemExit as e:
            if e.code is None:
                exit_code = 0
            elif isinstance(e.code, int):
                exit_code = e.code
            else:
                err.write(str(e.code) + "\n")
                exit_code = 1
        except BaseException:  # noqa: BLE001 - reported to the caller as a failed request
            err.write(traceback.format_exc())
            exit_code = 1
    finally:
        sys.argv, sys.stdin, sys.stdout, sys.stderr = saved[0], saved[1], saved[2], saved[3]
        try:
            os.chdir(saved[4])
        except OSError:
            pass
    return {"exitCode": exit_code, "stdout": out.getvalue(), "stderr": err.getvalue()}


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: worker_host.py <target_script.py>\n")
        sys.exit(2)
    script_path = os.path.abspath(sys.argv[1])

    # Private protocol channels; fd 1 then points at stderr so stray native writes cannot reach the protocol.
    proto_in = os.fdopen(os.dup(0), "r", encoding="utf-8", newline="\n")
    proto_out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)

    def send(obj):
        proto_out.write(json.dumps(obj) + "\n")
        proto_out.flush()

    try:
        module = _load_target(script_path)
    except BaseException as e:  # noqa: BLE001 - the parent reports it
        send({"fatal": f"the worker could not import {script_path}: {e}", "traceback": traceback.format_exc()})
        sys.exit(3)

    send({"ready": True, "pid": os.getpid()})
    for line in proto_in:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError as e:
            send({"protocolError": f"request line is not JSON: {e}"})
            continue
        if request.get("shutdown"):
            break
        answer = _serve_one(module, script_path, request)
        answer["id"] = request.get("id")
        send(answer)


if __name__ == "__main__":
    main()
