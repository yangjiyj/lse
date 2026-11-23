#!/usr/bin/env python3
"""Convert the pinned MITRE ATLAS YAML to compact JSON."""
import datetime
import json
import pathlib
import sys

import yaml

source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "apps/api/src/modules/frameworks/data/ATLAS.yaml")
target = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "apps/api/src/modules/frameworks/data/atlas-v2026.09.json")
data = yaml.safe_load(source.read_text(encoding="utf-8"))
target.write_text(
    json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=lambda value: value.isoformat() if isinstance(value, (datetime.date, datetime.datetime)) else str(value)) + "\n",
    encoding="utf-8",
)
