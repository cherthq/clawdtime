"""Read connector ownership with a scoped CLI login, without changing ownership."""
import json
import os
import stat
import time


def scoped_cli_headers(path, project, origin):
    try:
        if path.is_symlink() or path.parent.is_symlink():
            return None
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            return None
        data = json.loads(path.read_text())
        token = data.get('access_token', '')
        if (data.get('kind') != 'cli' or data.get('project_id') != project
                or data.get('origin') != origin or data.get('expires_at', 0) <= time.time() * 1000
                or not isinstance(token, str) or not token.startswith('ftu_')
                or '\n' in token or '\r' in token):
            return None
        return {'Authorization': 'Bearer ' + token, 'X-Chert-Project-Id': project}
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def connectors_idle(response, project, line):
    if response.status_code != 200:
        return False
    try:
        items = response.json()['data']
        if not isinstance(items, list):
            return False
        for item in items:
            scope = item['scope']
            if scope['project_id'] != project or not scope.get('line_id'):
                return False
            if scope['line_id'] == line and (item.get('state') != 'revoked' or item.get('connected') is not False):
                return False
        return True
    except (ValueError, KeyError, TypeError, AttributeError):
        return False
