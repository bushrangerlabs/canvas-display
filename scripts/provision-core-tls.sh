#!/bin/sh
# Do not trace provisioning, even when invoked with sh -x.
set +x
set -eu
umask 077
exec python3 - "$@" <<'PY'
import ipaddress
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys


def fail(message):
    print("provision-core-tls: " + message, file=sys.stderr)
    sys.exit(1)


if len(sys.argv) < 4:
    fail("usage: provision-core-tls.sh OUTPUT_DIR IP DNS [DNS ...] (no defaults)")
try:
    ip = str(ipaddress.ip_address(sys.argv[2]))
    if '%' in ip:
        raise ValueError("scoped address")
except ValueError:
    fail("IP must be an explicit IPv4 or IPv6 address without a zone identifier")
names = sys.argv[3:]
label = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", re.ASCII)
for name in names:
    if len(name) > 253 or not all(label.fullmatch(part) for part in name.split('.')):
        fail("DNS names must be ASCII hostnames, without wildcards or trailing dots")
    try:
        ipaddress.ip_address(name)
    except ValueError:
        continue
    fail("DNS names must not be IP literals")
if shutil.which("openssl") is None:
    fail("openssl is required")

# Resolve the parent, not the destination: dangling destination symlinks must
# count as existing paths too. No git executable is needed for these guards.
raw = Path(sys.argv[1])
if raw.name in ('', '.', '..'):
    fail("OUTPUT_DIR must name a new directory")
try:
    parent = raw.parent.resolve(strict=True)
    info = parent.stat()
    if not stat.S_ISDIR(info.st_mode):
        fail("OUTPUT_DIR parent must be a directory")
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        fail("OUTPUT_DIR parent must be owned by this user and not group/world writable")
    for ancestor in (parent, *parent.parents):
        if os.path.lexists(ancestor / '.git') or (
            (ancestor / 'HEAD').is_file() and (ancestor / 'objects').is_dir()
            and (ancestor / 'refs').is_dir()
        ):
            fail("OUTPUT_DIR must be outside Git worktrees and bare repositories")
    output = parent / raw.name
    if os.path.lexists(output):
        fail("OUTPUT_DIR already exists; refusing to overwrite")
    output.mkdir(mode=0o700)
except OSError:
    fail("cannot create OUTPUT_DIR; use a new path beneath an existing private parent")


def run(*args):
    # Explicit configs below avoid relying on a host's openssl.cnf. Never print
    # subprocess output (including on failure), and never export a private key.
    subprocess.run(['openssl', *args], cwd=output, check=True,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


try:
    (output / 'ca.cnf').write_text('''[req]
prompt = no
distinguished_name = dn
x509_extensions = ca
[dn]
CN = Canvas Core TLS Root CA
[ca]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
''', encoding='ascii')
    (output / 'server.cnf').write_text('''[req]
prompt = no
distinguished_name = dn
[dn]
CN = Canvas Core TLS Server
[server]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
subjectAltName = @san
[san]
IP.1 = ''' + ip + '\n' + ''.join(
        f'DNS.{i} = {name}\n' for i, name in enumerate(names, 1)), encoding='ascii')
    run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', 'ca.key')
    run('req', '-new', '-x509', '-sha256', '-days', '3650', '-key', 'ca.key',
        '-config', 'ca.cnf', '-out', 'ca.crt')
    run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', 'server.key')
    run('req', '-new', '-sha256', '-key', 'server.key', '-config', 'server.cnf', '-out', 'server.csr')
    run('x509', '-req', '-sha256', '-days', '397', '-in', 'server.csr',
        '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '0x' + os.urandom(16).hex(),
        '-extfile', 'server.cnf', '-extensions', 'server', '-out', 'server.crt')
    run('verify', '-x509_strict', '-CAfile', 'ca.crt', '-purpose', 'sslserver',
        '-verify_ip', ip, 'server.crt')
    for name in names:
        run('verify', '-x509_strict', '-CAfile', 'ca.crt', '-purpose', 'sslserver',
            '-verify_hostname', name, 'server.crt')
    for name in ('ca.cnf', 'server.cnf', 'server.csr'):
        (output / name).unlink()
    for name in ('ca.key', 'ca.crt', 'server.key', 'server.crt'):
        (output / name).chmod(0o600)
except (OSError, subprocess.SubprocessError):
    shutil.rmtree(output)
    fail("provisioning failed; newly created output removed")
print("Created private TLS directory with ca.key, ca.crt, server.key, server.crt. "
      "Distribute only ca.crt to clients; no deployment performed.")
PY
