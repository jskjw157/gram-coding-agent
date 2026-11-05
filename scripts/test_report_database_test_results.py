"""The CI reporter must never publish native failure bodies or arbitrary report fields."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).with_name('report_database_test_results.py')
spec = importlib.util.spec_from_file_location('database_reporter', HELPER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SECRET = 'never-publish-fixture-credential-9f4a72'
TITLE = 'returns an actual prepared SELECT result with verified TLS'


class DatabaseReporterTests(unittest.TestCase):
    def report(self, title=TITLE, message='Error: Database operation denied or failed'):
        return {'success': False, 'numTotalTests': 40, 'numPassedTests': 39, 'numFailedTests': 1,
                'numPendingTests': 0, 'testResults': [{'name': SECRET, 'assertionResults': [{
                    'title': title, 'ancestorTitles': ['mysql real read-only database'],
                    'status': 'failed', 'failureMessages': [message + '\n    at /private/' + SECRET +
                        '/tests/security/database-mysql.native.ts:114:25'], 'actual': SECRET,
                    'expected': 'SELECT password FROM ' + SECRET}]}]}

    def test_only_known_title_category_and_bounded_source_line_are_published(self):
        result = module.sanitize_report(self.report())
        self.assertEqual(result['failures'], [{'engine': 'mysql', 'test': TITLE,
            'category': 'DATABASE_DENIED_OR_FAILED',
            'source': 'tests/security/database-mysql.native.ts:114'}])
        self.assertEqual(result['counts'], {'total': 40, 'passed': 39, 'failed': 1, 'pending': 0})

    def test_secret_sql_expected_actual_and_arbitrary_paths_never_reach_output(self):
        result = module.sanitize_report(self.report(message='AssertionError: expected password=' + SECRET))
        serialized = json.dumps(result)
        self.assertNotIn(SECRET, serialized)
        self.assertNotIn('SELECT password', serialized)
        self.assertNotIn('/private/', serialized)
        self.assertEqual(result['failures'][0]['category'], 'ASSERTION')

    def test_unknown_titles_and_ancestors_are_replaced_with_static_values(self):
        report = self.report(title=SECRET)
        report['testResults'][0]['assertionResults'][0]['ancestorTitles'] = [SECRET]
        result = module.sanitize_report(report)
        self.assertEqual(result['failures'][0]['test'], 'unrecognized test')
        self.assertEqual(result['failures'][0]['engine'], 'unknown')
        self.assertNotIn(SECRET, json.dumps(result))

    def test_invalid_shapes_counts_and_source_locations_do_not_escape(self):
        report = self.report(message='Error: ' + SECRET + '\n at /tmp/evil.ts:123:4')
        report['numTotalTests'] = SECRET
        report['numFailedTests'] = 99999999999
        report['testResults'][0]['assertionResults'][0]['location'] = {'line': 99999999999}
        report['testResults'][0]['assertionResults'][0]['failureMessages'] = ['Error: ' + SECRET + '\n at /tmp/evil.ts:123:4']
        result = module.sanitize_report(report)
        self.assertEqual(result['counts']['total'], 0)
        self.assertEqual(result['counts']['failed'], 0)
        self.assertEqual(result['failures'][0]['source'], 'tests/security/database-mysql.native.ts')
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(module.sanitize_report(SECRET)['status'], 'unavailable')

    def test_collection_error_exposes_only_static_classification(self):
        report = {'success': False, 'testResults': [{'message': 'Cannot find module ' + SECRET}]}
        result = module.sanitize_report(report)
        self.assertEqual(result['failures'][0]['category'], 'MODULE_LOAD')
        self.assertEqual(result['failures'][0]['test'], 'setup or collection')
        self.assertNotIn(SECRET, json.dumps(result))

    def test_cli_never_prints_invalid_json_contents_or_private_argument_values(self):
        with tempfile.TemporaryDirectory(prefix='gram-db-report-test-') as directory:
            report = Path(directory, 'private.json')
            report.write_text(SECRET)
            report.chmod(0o600)
            result = subprocess.run([sys.executable, str(HELPER), str(report)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(SECRET, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout), {'status': 'unavailable'})
            report.write_text(json.dumps(self.report(message='Error: connect ECONNREFUSED ' + SECRET)))
            result = subprocess.run([sys.executable, str(HELPER), str(report)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertNotIn(SECRET, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)['failures'][0]['category'], 'CONNECTION_REFUSED')


if __name__ == '__main__':
    unittest.main()
