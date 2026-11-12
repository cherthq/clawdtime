"""Verify the deployment's explicit COPY list includes every runtime import."""
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


class PackagingTests(unittest.TestCase):
    def test_container_source_can_import_server_without_workspace_modules(self):
        source = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as directory:
            for line in (source / 'Dockerfile').read_text().splitlines():
                parts = shlex.split(line)
                if parts and parts[0] == 'COPY':
                    for filename in parts[1:-1]:
                        shutil.copyfile(source / filename, Path(directory) / filename)
            result = subprocess.run(
                [sys.executable, '-c', 'import server; import utterances'],
                cwd=directory, capture_output=True, text=True, timeout=20,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
