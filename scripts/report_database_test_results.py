"""Publish bounded classifications, never private Vitest failure bodies."""
import json
import os
import re
import stat
import sys

SOURCE = 'tests/security/database-mysql.native.ts'
TITLES = ('cancels a query already running on the server before settling', 'closes active work, rejects later queries and leaves no active server query', 'distinguishes an empty result and an exact row-cap result from truncation', 'enforces the deadline on a real server query and drains it', 'preserves duplicate columns and binds hostile-looking values as data', 'preserves exact large integers, decimals and explicit binary encoding', 'rejects a valid CA certificate with the wrong host identity', 'rejects an untrusted TLS authority without weakening verification', 'rejects byte and packet overflow instead of returning an empty success', 'rejects excessive metadata before exposing a result', 'rejects incorrect database authentication without exposing credential values', 'rejects write-capable accounts, statement mutations and unsafe functions', 'returns an actual prepared SELECT result with verified TLS', 'returns only the bounded row window and settles actual server work', 'screens the Agent MCP credential in binary results', 'screens the Agent MCP credential in embedded binary results', 'screens the Agent MCP credential in text results', 'screens the connection password in returned text and binary values', 'serves authenticated real MCP SELECT results and denies wrong authentication', 'uses a genuinely restricted account and server read-only transaction')
CATEGORIES = [
    ('CONNECTION_REFUSED', r'ECONNREFUSED'),
    ('TLS_HOST_IDENTITY', r'ERR_TLS_CERT_ALTNAME_INVALID|Hostname/IP does not match'),
    ('TLS_TRUST', r'self.signed certificate|unable to verify|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY'),
    ('DATABASE_AUTHENTICATION', r'Access denied for user|ER_ACCESS_DENIED'),
    ('CONNECTION_CLOSED', r'ECONNRESET|socket.*closed|connection.*closed'),
    ('QUERY_NOT_OBSERVED', r'Real fixture query did not enter the server process list'),
    ('TIMEOUT', r'timed out|timeout|ETIMEDOUT'),
    ('MODULE_LOAD', r'Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load|failed to resolve'),
    ('FIXTURE_VALIDATION', r'GRAM_DB_FIXTURE_FILE|Unsafe database fixture|Fixture container identity'),
    ('ASSERTION', r'AssertionError'),
    ('DATABASE_DENIED_OR_FAILED', r'Database operation denied or failed'),
    ('CLEANUP_QUARANTINED', r'cleanup.*quarantin|quiescence'),
]


def count(value):
    return value if type(value) is int and 0 <= value <= 10000 else 0


def classify(message):
    return next((name for name, pattern in CATEGORIES if re.search(pattern, message, re.I)), 'TEST_FAILURE')


def source(assertion, message):
    location = assertion.get('location')
    line = location.get('line') if isinstance(location, dict) else None
    if type(line) is not int or not 1 <= line <= 4096:
        match = re.search(r'tests[\\/]security[\\/]database-mysql\.native\.ts:(\d{1,4})(?::\d+)?', message)
        line = int(match.group(1)) if match and 1 <= int(match.group(1)) <= 4096 else None
    return SOURCE + (':' + str(line) if line is not None else '')


def sanitize_report(report):
    if not isinstance(report, dict):
        return {'status': 'unavailable'}
    failures = []
    suites = report.get('testResults', [])
    for suite in suites[:100] if isinstance(suites, list) else []:
        if not isinstance(suite, dict):
            continue
        assertions = suite.get('assertionResults', [])
        found = False
        for assertion in assertions[:1000] if isinstance(assertions, list) else []:
            if not isinstance(assertion, dict) or assertion.get('status') != 'failed':
                continue
            found = True
            title = assertion.get('title')
            ancestors = assertion.get('ancestorTitles', [])
            engine = next((kind for kind in ('mysql', 'mariadb')
                           if isinstance(ancestors, list) and kind + ' real read-only database' in ancestors), 'unknown')
            messages = assertion.get('failureMessages', [])
            message = '\n'.join(value[:65536] for value in messages[:8] if isinstance(value, str)) if isinstance(messages, list) else ''
            failures.append({'engine': engine, 'test': title if isinstance(title, str) and title in TITLES else 'unrecognized test',
                             'category': classify(message), 'source': source(assertion, message)})
            if len(failures) >= 80:
                break
        if not found and isinstance(suite.get('message'), str) and suite['message']:
            message = suite['message'][:65536]
            failures.append({'engine': 'unknown', 'test': 'setup or collection',
                             'category': classify(message), 'source': source({}, message)})
        if len(failures) >= 80:
            break
    return {'status': 'passed' if report.get('success') is True else 'failed',
            'counts': {'total': count(report.get('numTotalTests')), 'passed': count(report.get('numPassedTests')),
                       'failed': count(report.get('numFailedTests')), 'pending': count(report.get('numPendingTests'))},
            'failures': failures}


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError()
        fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 16777216:
                raise ValueError()
            data = stream.read(16777217)
            if len(data) > 16777216:
                raise ValueError()
        result = sanitize_report(json.loads(data))
        print(json.dumps(result, separators=(',', ':')))
        return 0 if result['status'] != 'unavailable' else 1
    except Exception:
        print('{"status":"unavailable"}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
