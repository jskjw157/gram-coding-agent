"""Validate generated MAC-02 test plists; never install or start a service."""
import copy
import pathlib
import plistlib
import sys
import xml.etree.ElementTree as ET

ROOT = '/Library/Application Support/HAAR/GramAgent'
RELEASE = ROOT + '/releases/lab-001'
KEYS = ['Label', 'UserName', 'ProgramArguments', 'WorkingDirectory', 'RunAtLoad',
        'KeepAlive', 'ThrottleInterval', 'ExitTimeOut', 'Umask',
        'StandardOutPath', 'StandardErrorPath']


def validate(value, role):
    assert role in ('core', 'tunnel')
    assert type(value) is dict and list(value) == KEYS
    expected = {
        'Label': 'com.haar.gram-agent.' + role,
        'UserName': 'gram-agent',
        'ProgramArguments': [RELEASE + '/bin/node',
                             RELEASE + '/packages/macos-lifecycle/dist/supervisor-cli.js',
                             '--role', role, '--config', ROOT + '/config/service.json'],
        'WorkingDirectory': RELEASE,
        'RunAtLoad': True, 'KeepAlive': True,
        'ThrottleInterval': 30, 'ExitTimeOut': 30, 'Umask': 63,
        'StandardOutPath': '/dev/null', 'StandardErrorPath': '/dev/null',
    }
    assert all(type(value[key]) is type(expected[key]) for key in KEYS)
    assert value == expected


def main():
    if len(sys.argv) != 2:
        raise SystemExit('USAGE: verify-plist.py FIXTURE_DIRECTORY')
    directory = pathlib.Path(sys.argv[1])
    rejected = 0
    for role in ('core', 'tunnel'):
        raw = (directory / (role + '.plist')).read_bytes()
        assert 0 < len(raw) <= 65536
        tree = ET.fromstring(raw)
        assert tree.tag == 'plist' and len(tree) == 1 and tree[0].tag == 'dict'
        children = list(tree[0])
        assert len(children) == len(KEYS) * 2
        assert [children[i].tag for i in range(0, len(children), 2)] == ['key'] * len(KEYS)
        assert [children[i].text for i in range(0, len(children), 2)] == KEYS
        value = plistlib.loads(raw)
        validate(value, role)
        for key, invalid in [('UserName', 'root'), ('Umask', 77), ('RunAtLoad', 1),
                             ('ProgramArguments', ['/bin/sh', '-c', 'anything']),
                             ('Label', 'foreign.service'), ('EnvironmentVariables', {'KEY': 'fixture'})]:
            changed = copy.deepcopy(value)
            changed[key] = invalid
            try:
                validate(changed, role)
            except AssertionError:
                rejected += 1
            else:
                raise AssertionError('validator accepted invalid ' + key)
    assert rejected == 12
    print('PLIST_STRUCTURE_PASS roles=2 negative_cases=12; no services installed')


if __name__ == '__main__':
    main()
