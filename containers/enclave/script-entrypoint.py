#!/usr/local/bin/python3
"""Materialize the assigned seed into bounded tmpfs, then run the script."""

import os
import runpy
import shutil
from pathlib import Path

SEED = Path("/awf/seed")
REPO = Path("/query/repo")
SCRIPT = "/awf/query-script.py"
OUTPUT = Path("/awf/out")

shutil.copytree(SEED, REPO, symlinks=True)
Path("/query/out").symlink_to(OUTPUT)
os.chdir("/query")
runpy.run_path(SCRIPT, run_name="__main__")
