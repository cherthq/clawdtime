"""Read explicit owner-only configuration; never discover other projects' secrets."""
import json
import os
import stat


def private_text(path):
    if path.parent.is_symlink():
        raise ValueError('Private configuration directory cannot be a symlink')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077):
            raise ValueError('Configuration must be an owner-only regular file')
        with os.fdopen(fd, 'r', closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def private_json(path):
    return json.loads(private_text(path))


def private_env(path):
    from io import StringIO
    from dotenv import dotenv_values
    return dotenv_values(stream=StringIO(private_text(path)), interpolate=False)
