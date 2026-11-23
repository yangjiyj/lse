#!/usr/bin/env python3
"""Start the isolated LSE API with a private runtime JSON file.

No credential is passed on the command line or written to logs.
"""
import json
import os
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: run-asset-assessment-lab.py PRIVATE_RUNTIME_JSON")
p = Path(sys.argv[1]).resolve(strict=True)
if p.stat().st_mode & 0o077:
    raise SystemExit("private runtime JSON must be mode 0600")
values = json.loads(p.read_text())
allowed = {"API_PORT", "DATABASE_URL", "JWT_SECRET", "LICENSE_ENFORCE", "NODE_ENV", "REDIS_URL"}
if set(values) != allowed or not all(isinstance(v, str) for v in values.values()):
    raise SystemExit("private runtime JSON keys invalid")
os.environ.update(values)
root = Path(__file__).resolve().parents[1]
os.chdir(root / "apps" / "api")
os.execv("/usr/bin/node", ["/usr/bin/node", str(root / "node_modules" / "tsx" / "dist" / "cli.mjs"), "src/index.ts"])
