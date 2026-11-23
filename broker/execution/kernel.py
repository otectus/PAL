"""Run Python cells in order in this sandbox's namespace; fd 4 carries bounded progress."""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, "/work/lab")
import lab_data

namespace = {"__name__": "__main__"}
cells = json.loads(Path("/work/kernel-input.json").read_text())
with os.fdopen(4, "w", buffering=1) as progress:
    for index, cell in enumerate(cells):
        folder = Path("/work/output") / f"cell-{index + 1}"
        folder.mkdir()
        os.chdir(folder)
        lab_data.output = folder
        print(index, "running", file=progress)
        try:
            exec(compile(cell["code"], f'<cell {index + 1}>', "exec"), namespace)
        except BaseException:
            print(index, "failed", file=progress)
            raise
        print(index, "completed", file=progress)
