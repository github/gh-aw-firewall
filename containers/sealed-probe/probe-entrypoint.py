#!/usr/local/bin/python3
"""Materialize the assigned seed into bounded tmpfs, then run the probe."""

import os
import runpy
import shutil
from pathlib import Path

SEED = Path("/awf/seed")
REPO = Path("/probe/repo")
SCRIPT = "/awf/probe-script.py"

shutil.copytree(SEED, REPO, symlinks=True)
os.chdir("/probe")
runpy.run_path(SCRIPT, run_name="__main__")
