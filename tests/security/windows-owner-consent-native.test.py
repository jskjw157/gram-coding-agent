"""Protocol/availability checks only: never synthesize a human approval."""
import json
import pathlib
import subprocess
import sys
import unittest

HELPER = pathlib.Path(sys.argv.pop(1)).resolve()

class OwnerConsentProtocol(unittest.TestCase):
    def call(self, value):
        result = subprocess.run([str(HELPER)], input=json.dumps(value), text=True,
                                encoding='utf-8', capture_output=True, timeout=10, check=False)
        self.assertEqual(result.stderr, '')
        response = json.loads(result.stdout)
        self.assertNotIn('content', response)
        return response

    def test_real_os_availability_is_truthful_without_an_authentication_prompt(self):
        self.assertIn(self.call({'operation': 'availability'})['status'], ['AVAILABLE', 'UNAVAILABLE'])

    def test_remote_verified_claim_and_unknown_fields_do_not_grant_consent(self):
        self.assertEqual(self.call({'operation': 'approve', 'status': 'VERIFIED'})['status'], 'DENIED')
        self.assertEqual(self.call({'operation': 'availability', 'content': 'must-not-display-fixture'})['status'], 'DENIED')

    def test_expired_or_malformed_challenges_are_denied_before_native_authentication(self):
        invalid = {'operation': 'verify', 'challengeId': 'not-a-nonce', 'bindingDigest': 'bad',
                   'issuedAt': 0, 'expiresAt': 1, 'expectedOwnerSid': 'invalid',
                   'target': {'action': 'protected-reveal', 'rootId': 'fixture', 'path': '.env', 'destination': None}}
        self.assertEqual(self.call(invalid)['status'], 'DENIED')

if __name__ == '__main__':
    unittest.main()
