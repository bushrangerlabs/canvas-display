"""Offline integration tests: ephemeral keys outside the checkout, real OpenSSL."""
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts' / 'provision-core-tls.sh'


class ProvisionTLS(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('openssl') or not shutil.which('python3'):
            raise RuntimeError('Tests require openssl and python3')
        cls.temp = tempfile.TemporaryDirectory(prefix='canvas-tls-', dir='/tmp')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.base = Path(cls.temp.name)
        cls.output = cls.base / 'issued'
        result = cls.provision(cls.output)
        if result.returncode:
            raise RuntimeError(result.stderr)
        cls.other = cls.base / 'other-root'
        result = cls.provision(cls.other)
        if result.returncode:
            raise RuntimeError(result.stderr)

    @staticmethod
    def provision(output, *identities):
        return subprocess.run(
            ['sh', str(SCRIPT), str(output), *(identities or (
                '192.168.1.108', 'localhost', 'canvas-core.local'))],
            capture_output=True, text=True, timeout=60)

    def openssl(self, *args):
        return subprocess.run(['openssl', *args], cwd=self.output,
                              capture_output=True, text=True, timeout=15)

    def verify(self, *args, ca='ca.crt'):
        return self.openssl('verify', '-x509_strict', '-CAfile', ca,
                            '-no-CApath', '-no-CAstore', '-purpose', 'sslserver',
                            *args, 'server.crt')

    def test_chain_hostname_and_ip(self):
        for args in ((), ('-verify_hostname', 'localhost'),
                     ('-verify_hostname', 'canvas-core.local'),
                     ('-verify_ip', '192.168.1.108')):
            with self.subTest(args=args):
                result = self.verify(*args)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_hostname_ip_and_unknown_root_rejected(self):
        for args in (('-verify_hostname', 'wrong.example'),
                     ('-verify_hostname', 'sub.canvas-core.local'),
                     ('-verify_ip', '192.168.1.109')):
            with self.subTest(args=args):
                result = self.verify(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('mismatch', result.stderr)
        result = self.verify('-verify_hostname', 'localhost', ca=str(self.other / 'ca.crt'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unable to get local issuer certificate', result.stderr)

    def test_certificate_profiles(self):
        for filename, constraints, usage in (
            ('ca.crt', 'CA:TRUE, pathlen:0', 'Certificate Sign, CRL Sign'),
            ('server.crt', 'CA:FALSE', 'Digital Signature, Key Encipherment'),
        ):
            with self.subTest(filename=filename):
                result = self.openssl('x509', '-in', filename, '-noout', '-text')
                self.assertEqual(result.returncode, 0, result.stderr)
                text = result.stdout
                for expected in ('sha256WithRSAEncryption', 'Public Key Algorithm: rsaEncryption',
                                 'Public-Key: (3072 bit)', 'X509v3 Basic Constraints: critical',
                                 'X509v3 Key Usage: critical', constraints, usage):
                    self.assertIn(expected, text)
                if filename == 'server.crt':
                    self.assertIn('TLS Web Server Authentication', text)
                    self.assertIn('IP Address:192.168.1.108, DNS:localhost, DNS:canvas-core.local', text)
                else:
                    self.assertNotIn('TLS Web Server Authentication', text)

    def test_permissions_and_no_private_output(self):
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)
        self.assertEqual({p.name for p in self.output.iterdir()},
                         {'ca.key', 'ca.crt', 'server.key', 'server.crt'})
        for path in self.output.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        # Capture a fresh invocation, including an inherited permissive umask
        # and shell xtrace. No key contents are read or printed by this test.
        target = self.base / 'traced'
        result = subprocess.run(
            ['sh', '-c', 'umask 000; exec sh -x "$@"', 'test', str(SCRIPT),
             str(target), '::1', 'localhost'], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('PRIVATE KEY', result.stdout + result.stderr)
        self.assertNotIn('genpkey', result.stderr)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
        for path in target.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_existing_directory_file_and_symlink_never_overwritten(self):
        before = {p.name: (p.stat().st_ino, p.stat().st_size, p.stat().st_mtime_ns)
                  for p in self.output.iterdir()}
        result = self.provision(self.output)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, {p.name: (p.stat().st_ino, p.stat().st_size, p.stat().st_mtime_ns)
                                  for p in self.output.iterdir()})
        file = self.base / 'existing-file'
        file.write_text('unchanged')
        link = self.base / 'dangling-link'
        link.symlink_to(self.base / 'absent')
        directory = self.base / 'empty-directory'
        directory.mkdir()
        for path in (file, link, directory):
            self.assertNotEqual(self.provision(path).returncode, 0)
        self.assertEqual(file.read_text(), 'unchanged')
        self.assertTrue(link.is_symlink())
        self.assertEqual(list(directory.iterdir()), [])

    def test_invalid_or_missing_identities_create_nothing(self):
        target = self.base / 'invalid'
        cases = [(), ('192.168.1.108',), ('bad-ip', 'localhost'),
                 ('fe80::1%eth0', 'localhost'), ('192.168.1.108', '192.168.1.108')]
        cases += [('192.168.1.108', name) for name in (
            '*.example', '-bad.example', 'bad-.example', 'a..b', 'localhost.',
            'name\nDNS.9 = attacker.example', 'name,IP:1.2.3.4', 'a/b',
            'a' * 64 + '.example', 'é.example', '', 'a;b', '$ENV::HOME')]
        for identities in cases:
            with self.subTest(identities=identities):
                result = subprocess.run(['sh', str(SCRIPT), str(target), *identities],
                                        capture_output=True, text=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(target.exists())

    def test_git_ancestors_including_symlinks_and_bare_repos_rejected(self):
        for kind in ('worktree', 'linked-worktree', 'bare'):
            repo = self.base / kind
            repo.mkdir(mode=0o700)
            if kind == 'worktree':
                (repo / '.git').mkdir()
            elif kind == 'linked-worktree':
                (repo / '.git').write_text('gitdir: /unused')
            else:
                (repo / 'HEAD').write_text('ref: refs/heads/main')
                (repo / 'objects').mkdir()
                (repo / 'refs').mkdir()
            nested = repo / 'nested'
            nested.mkdir(mode=0o700)
            alias = self.base / (kind + '-alias')
            alias.symlink_to(nested, target_is_directory=True)
            for parent in (nested, alias):
                result = self.provision(parent / 'tls')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('outside Git', result.stderr)
                self.assertFalse((parent / 'tls').exists())

    def test_unsafe_or_missing_parent_rejected(self):
        parent = self.base / 'shared'
        parent.mkdir()
        parent.chmod(0o777)
        for target in (parent / 'tls', self.base / 'missing' / 'tls'):
            self.assertNotEqual(self.provision(target).returncode, 0)
            self.assertFalse(target.exists())

    def test_openssl_failure_cleans_only_new_directory(self):
        # A controlled failing executable verifies fail-closed cleanup without
        # touching existing outputs or depending on host OpenSSL configuration.
        bin_dir = self.base / 'bin'
        bin_dir.mkdir()
        fake = bin_dir / 'openssl'
        fake.write_text('#!/bin/sh\nexit 1\n')
        fake.chmod(0o700)
        target = self.base / 'failed'
        result = subprocess.run(
            ['sh', str(SCRIPT), str(target), '192.168.1.108', 'localhost'],
            env={**os.environ, 'PATH': str(bin_dir) + os.pathsep + os.environ['PATH']},
            capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(target.exists())
        self.assertTrue(self.output.is_dir())
        self.assertNotIn('PRIVATE KEY', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
