"""The image of the gateway holds every module of this folder that its programs import."""
import ast
import fnmatch
import json
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def dockerfile():
    return [line.split() for line in (HERE / 'Dockerfile').read_text().splitlines() if line.strip()]


def copied():
    """The files of this folder that a COPY of the Dockerfile puts in the image."""
    sources = []
    for words in dockerfile():
        if words[0].upper() == 'COPY' and not any(word.startswith('--from') for word in words[1:]):
            sources += [word for word in words[1:-1] if not word.startswith('--')]
    return {path.name for path in HERE.iterdir() if any(fnmatch.fnmatch(path.name, source) for source in sources)}


def program():
    """The program that the image runs: the script of its CMD."""
    for words in dockerfile():
        if words[0].upper() == 'CMD':
            command = json.loads(' '.join(words[1:]))
            return next(word for word in command if word.endswith('.py'))
    raise AssertionError('The Dockerfile has no CMD.')


def local_imports(name):
    """The modules of this folder that one file imports, at the top or inside a function."""
    found = set()
    for node in ast.walk(ast.parse((HERE / name).read_text(), name)):
        if isinstance(node, ast.Import):
            found.update(alias.name.split('.')[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            found.add(node.module.split('.')[0])
    return {f'{module}.py' for module in found if (HERE / f'{module}.py').is_file()}


class ImageFilesTests(unittest.TestCase):
    def test_the_image_copies_every_module_that_its_programs_import(self):
        needed, todo = set(), [program(), 'service.py', 'relay.py']
        while todo:
            name = todo.pop()
            if name not in needed:
                needed.add(name)
                todo.extend(local_imports(name))
        self.assertIn('native_relay.py', needed)
        self.assertEqual(sorted(needed - copied()), [])


if __name__ == '__main__':
    unittest.main()
