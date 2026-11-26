import json
import pytest
from private_config import private_json, private_env


def test_private_config_preserves_literals(tmp_path):
    path = tmp_path / 'config'
    path.write_text(json.dumps({'destination': '+15555550100'}))
    path.chmod(0o600)
    assert private_json(path)['destination'] == '+15555550100'
    path.write_text('EXAMPLE_TOKEN=${DO_NOT_EXPAND}\n')
    assert private_env(path)['EXAMPLE_TOKEN'] == '${DO_NOT_EXPAND}'


def test_private_config_rejects_public_files_and_symlinks(tmp_path):
    path = tmp_path / 'config'
    path.write_text('{}')
    path.chmod(0o644)
    with pytest.raises(ValueError):
        private_json(path)
    path.chmod(0o600)
    link = tmp_path / 'link'
    link.symlink_to(path)
    with pytest.raises(OSError):
        private_json(link)
