import json
import time
import httpx
import pytest
from connector_preflight import connectors_idle, scoped_cli_headers


def binding(state='revoked', connected=False, line='selected'):
    return {'scope': {'project_id': 'project', 'line_id': line}, 'state': state, 'connected': connected}


@pytest.mark.parametrize('items,expected', [
    ([], True), ([binding()], True), ([binding('active')], False),
    ([binding('draining')], False), ([binding(connected=True)], False),
    ([binding(connected=None)], False), ([{}], False), (None, False),
    ([binding('active', True, 'other')], True),
    ([{'scope': {'project_id': 'wrong', 'line_id': 'selected'}}], False),
])
def test_ownership(items, expected):
    assert connectors_idle(httpx.Response(200, json={'data': items}), 'project', 'selected') is expected


def test_refusal_is_not_an_empty_inventory():
    assert not connectors_idle(httpx.Response(403, json={'data': []}), 'project', 'selected')


def test_credentials_are_scoped_and_private(tmp_path):
    path = tmp_path / 'credentials.json'
    assert scoped_cli_headers(path, 'project', 'https://example.invalid') is None
    data = {'kind':'cli', 'project_id':'project', 'origin':'https://example.invalid',
            'expires_at': (time.time()+60)*1000, 'access_token':'ftu_synthetic'}
    path.write_text(json.dumps(data)); path.chmod(0o600)
    assert scoped_cli_headers(path, 'project', data['origin'])
    assert scoped_cli_headers(path, 'other', data['origin']) is None
    assert scoped_cli_headers(path, 'project', 'https://other.invalid') is None
    path.chmod(0o644)
    assert scoped_cli_headers(path, 'project', data['origin']) is None
    path.chmod(0o600); data['expires_at'] = 1; path.write_text(json.dumps(data))
    assert scoped_cli_headers(path, 'project', data['origin']) is None
