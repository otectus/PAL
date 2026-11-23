#!/usr/bin/env python3
"""Compatibility launcher for pre-PAL Fish configurations."""

from pathlib import Path
import os
import sys

target = Path(__file__).with_name("pal-memory-emitter.py")
os.execv(target, [str(target), *sys.argv[1:]])
