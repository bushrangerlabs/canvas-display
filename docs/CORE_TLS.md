# Core TLS provisioning and trust

`scripts/provision-core-tls.sh` creates a **new private RSA CA and an RSA server
certificate on Core**. It does not install certificates, edit service configuration,
contact devices, restart services, or deploy anything. The coordinator owns live
configuration changes, rollout, and deployment-health acceptance.

## Generate on Core, outside versioned directories

Requirements: POSIX shell, Python 3 (standard library only), and OpenSSL (OpenSSL 3
is used by the tests). Run as the account that will own the keys, on the Core host,
in a trusted environment. Do not generate production private keys on a developer
checkout and transfer them later. No package installation is performed.

The interface has **no address or hostname defaults**:

```text
sh scripts/provision-core-tls.sh OUTPUT_DIR IP DNS [DNS ...]
```

Supply one IPv4 or IPv6 address and at least one ASCII DNS hostname. Include every
name actually used in HTTPS/WSS URLs. Names do not configure DNS; arrange local
DNS/mDNS separately. Wildcards, trailing dots, Unicode names (use validated ASCII
IDNA names instead), scoped IPv6 addresses, and IP literals in DNS arguments are
rejected. No user argument is interpreted as an OpenSSL configuration directive.

Example **to run on Core**, from a checkout or with a reviewed copy of the script:

```sh
# Once: create a private parent owned by the provisioning account.
# /var/lib/canvas-core must already be an appropriate, administrator-owned location.
install -d -m 0700 /var/lib/canvas-core/tls
sh scripts/provision-core-tls.sh \
  /var/lib/canvas-core/tls/generation-2026-09 \
  192.168.1.108 localhost canvas-core.local
```

Use an appropriately privileged account for the example location; do not loosen
parent permissions to make provisioning work. `OUTPUT_DIR` must **not exist**, not
even as an empty directory, regular file, or dangling symlink. Its parent must
already exist, belong to the invoking account, and not be group/world writable.
The script resolves parent symlinks and rejects paths beneath Git worktrees
(including `.git` files for linked worktrees) and recognizable bare repositories.
This guard is not an inventory of all version-control systems, backups, bind
mount aliases, or remote synchronization: the operator must choose a genuinely
unversioned, private location and keep ancestors under trusted administration.

Generated artifacts:

| File | Role | Distribution |
| --- | --- | --- |
| `ca.key` | RSA 3072-bit CA signing key | Core/private offline backup only; never clients or the repository |
| `ca.crt` | Public, self-signed root CA | Authenticated distribution to clients |
| `server.key` | RSA 3072-bit leaf key | Core TLS terminator only |
| `server.crt` | Public server certificate | Core TLS terminator; public inspection is safe |

The directory is mode `0700`; all four files are `0600`, with `umask 077` set
before creation. Private keys are unencrypted for unattended service use: protect
the filesystem and backups. No private key is printed, and shell tracing is
disabled. Normal generation failures remove only the newly created directory;
a process/host interruption may leave a partial directory. Inspect such a
directory privately and choose a fresh destination; never assume it is complete.
Existing paths are never overwritten. A second invocation creates a **different
CA**, not a renewal under the previous CA.

Both certificates use SHA-256 RSA signatures. The CA is valid for 3650 days and has
critical `CA:true,pathlen:0` and critical `keyCertSign,cRLSign`. The leaf is valid
for 397 days and has critical `CA:false`, critical
`digitalSignature,keyEncipherment`, and `serverAuth` extended key usage. Its SANs
are exactly the supplied IP and DNS names; the CN is not a hostname fallback.
Subject/authority key identifiers are included. This is a minimal local PKI,
not an automated issuance, CRL distribution, revocation, or renewal service.
Schedule expiry monitoring and replacement ahead of time.

Grant only the Core TLS process access to `server.key` through the deployment's
secure secret-mount/ownership mechanism. Do not mount `ca.key` into the application
container: after issuance, secure it for CA operations/offline backup. Do not make
keys world-readable to accommodate a container UID. Coordinate the configured
certificate/key paths and any service reload separately.

## Repository deployment policy and coordinator handoff

The coordinator reports generating the new RSA CA/leaf on live Core at
`/home/spetchal/canvas-core-tls-private-20260926/generation-1`, outside the repository.
This is a reported provisioning location, not evidence here of deployment or of
what the live endpoint serves. No remote access or deployment is performed by
this repository configuration change.

`core/nginx.conf` now selects exactly one RSA identity: `server.crt` and
`server.key`. Its intended names are `192.168.1.108`, `localhost`, and
`canvas-core.local`; the leaf must contain the IP SAN and both DNS SANs.
`server_name` does not create or validate SANs. The Ed25519/dual-certificate TLS
selection is removed; application enrollment remains unchanged.

`core/docker-compose.yml` requires nonempty `CANVAS_CORE_TLS_DIR` (no repository
fallback). Set it on **Core**, in the Compose environment or the remote
`core/.env`, to the absolute external generation directory:

```text
CANVAS_CORE_TLS_DIR=/home/spetchal/canvas-core-tls-private-20260926/generation-1
```

Compose mounts only `server.crt`, `server.key`, and public `ca.crt`, individually
and read-only at `/etc/nginx/tls/`. Missing source files fail rather than becoming
empty directories. It never mounts `ca.key` or the whole private directory.
The public CA mount does not enable mTLS or automatically give clients trust.
The external absolute-path requirement is operator policy; Compose's required
variable check enforces presence, not whether a path is outside Git.

The deploy helper requires `CANVAS_CORE_HEALTH_CA_FILE` in its **local invocation
environment**, naming an absolute, readable public CA file on the **remote Core
host**. It does not upload that file, infer trust from `DEST/core/tls`, source the
remote `.env`, or print resolved Compose configuration/environment secrets.
For a future authorized invocation, the path setting is:

```text
CANVAS_CORE_HEALTH_CA_FILE=/home/spetchal/canvas-core-tls-private-20260926/generation-1/ca.crt
```

A separately installed, authenticated public copy is also valid. Health uses
`curl --cacert` against `https://localhost:3100/health`, preserving chain and
hostname verification with bounded requests and no insecure fallback. That URL
retains the helper's existing port assumption; the certificate needs `localhost`
even when clients use the IP. Failure to read the CA or verify HTTPS fails the
helper. `pipefail` also prevents failed build/transfer pipelines from being
reported as successful. The helper's existing build paths and payload list are
otherwise unchanged; it is not validated as a complete deployment workflow here.

The coordinator deploys manually and separately preserves live nginx SSE and
WebSocket changes. Do not overwrite live nginx wholesale with this file without
reconciling those changes. Container recreation/reload, live certificate checks,
and client acceptance remain coordinator work.

`.gitignore` excludes `*.key` beneath `core/tls` and accidental repository-root
`canvas-core-tls-private-*` output directories, not public CA resources outside
those private output directories. Ignore rules do **not** untrack existing keys:
`core/tls/server.key` and `core/tls/rsa-server.key` remain tracked. They must not
be reused; approved index/history/artifact cleanup is separate work. No existing
files are deleted by this change.

## Verify certificates and the endpoint identity

The script verifies the generated chain, server purpose, IP, and each hostname
locally. The following explicit checks are also safe (public certificates only):

```sh
openssl verify -x509_strict -CAfile /var/lib/canvas-core/tls/generation-2026-09/ca.crt \
  -purpose sslserver -verify_ip 192.168.1.108 \
  /var/lib/canvas-core/tls/generation-2026-09/server.crt
openssl verify -x509_strict -CAfile /var/lib/canvas-core/tls/generation-2026-09/ca.crt \
  -purpose sslserver -verify_hostname canvas-core.local \
  /var/lib/canvas-core/tls/generation-2026-09/server.crt
openssl x509 -in /var/lib/canvas-core/tls/generation-2026-09/ca.crt \
  -noout -sha256 -fingerprint
```

A trusted chain alone is **not hostname verification**. A client using
`https://192.168.1.108` must verify the IP SAN; a client using
`https://canvas-core.local` must verify that DNS SAN. TLS SNI selection alone also
does not verify the hostname. Never use `curl -k`, `rejectUnauthorized: false`,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, trust-all managers, hostname bypasses, or an HTTP
fallback. Verify the public CA fingerprint over an authenticated independent
channel before installation, not by accepting whatever an untrusted endpoint
serves.

Local certificate checks do not prove what Core is serving. After an authorized
rollout, the coordinator must check the actual HTTPS/WSS endpoint with explicit
CA trust and the URL's hostname/IP, then test each real client stack. No network
acceptance is performed by this script or its tests.

## Client trust: distribute only the public CA

Never distribute either private key, use the enrollment credential as a CA, or
silently trust the leaf as a substitute for the intended CA policy.

### Linux system trust and WebKit

On Debian/Ubuntu, install a verified **copy of `ca.crt`** as
`/usr/local/share/ca-certificates/canvas-core-ca.crt` (public, mode `0644`) and run
`sudo update-ca-certificates`. This is a system-wide trust expansion, so require
administrator approval. Other distributions use different trust-store tooling.
Restart affected clients as needed. Validate Linux WebKit HTTPS and WSS using the
actual Core URL; sandbox/container trust stores may differ from the host's.

Rust agent/updater TLS backends may use native roots or a separately constructed
root store. Confirm the actual backend/configuration and test each path; installing
a system root is not evidence that every Rust connection trusts it.

### Node.js sidecar

For Node processes that do not consume the system store, set this in the real
service/container environment **before process startup**:

```sh
NODE_EXTRA_CA_CERTS=/absolute/path/to/public/canvas-core-ca.crt
```

Mount/copy only the public CA to that readable path and restart the process.
`NODE_EXTRA_CA_CERTS` extends default trust; it is not read dynamically after
startup. Explicit per-connection `ca` options can override the usual trust path;
check any custom HTTPS/WSS agents. Retain Node's normal certificate and hostname
verification. This variable does not configure WebKit, Rust, or Android.

### Android Network Security Configuration (NSC)

Modern Android apps generally do not trust user-installed roots by default.
Coordinate a narrowly scoped release NSC policy and bundle **only `ca.crt`** as a
public raw resource (for example `res/raw/canvas_core_ca.pem`). An illustrative
policy for DNS-based Core URLs is:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="false">canvas-core.local</domain>
        <trust-anchors>
            <certificates src="@raw/canvas_core_ca" />
        </trust-anchors>
    </domain-config>
</network-security-config>
```

The application manifest must reference that XML using
`android:networkSecurityConfig="@xml/network_security_config"`. The XML above is illustrative. The current repository policy in
`browser/android-native/app/src/main/res/xml/network_security_config.xml` already
selects `@raw/canvas_core_ca` for `192.168.1.108` and `canvas-core.local`, forbids
cleartext for those destinations, and retains system/user trust and cleartext
for other panel destinations. That existing implementation is not modified here.
Its public resource is
`browser/android-native/app/src/main/res/raw/canvas_core_ca.pem`: it must be an
authenticated copy of the **new live root CA**, not a leaf, private key, or
application enrollment credential. Resource naming/policy wiring alone does not
prove its bytes match the coordinator's new root; compare public SHA-256
fingerprints before release. The adjacent historical leaf resources
`canvas_core_192_168_1_108.pem` and `canvas_core_rsa_192_168_1_108.pem` are not the
root selected by this policy. This change neither replaces those resources nor
claims a released app trusts the live root. Scope policy to the actual production URL(s);
if IP URLs are required, explicitly verify their policy matching and IP SAN on the
target Android versions rather than assuming the DNS policy covers them. Do not
add `localhost` trust on devices merely because it is a server SAN: localhost
refers to each device itself.

Confirm NSC use in both the native HTTP/WSS stack and WebView on supported Android
versions. Custom native trust managers may not use platform NSC, and a native-only
CA change does not establish WebView trust. Never call WebView
`SslErrorHandler.proceed()` or disable OkHttp hostname verification. Verify both
paths in a release build, not just a debug trust override.

## Enrollment is separate from TLS

[PAIRING_ENROLLMENT_CONTRACT.md](PAIRING_ENROLLMENT_CONTRACT.md) specifies an
Ed25519 proof-of-possession flow and a **signed JSON application credential**, not
an X.509 client certificate. It does not establish TLS server trust or mTLS.
This TLS CA/leaf pair protects and authenticates the server transport; it does not
replace device enrollment keys, invitations, gateway authorization, or signed
JSON credential verification. Do not rotate enrollment identities as an accidental
side effect of a TLS-only rollout.

## Rotation and previously tracked private keys

Treat any private TLS key ever tracked in Git or shared in logs/artifacts as
compromised, even after deleting the current file. Do not read, copy, reuse, or
reproduce such keys for diagnosis. Owner-led response should inventory exposure,
generate fresh material on Core outside Git, distribute the new public root via an
authenticated channel, switch Core to the new leaf/key, and remove old root trust
once all clients have migrated. If the CA key was exposed, issuing another leaf
under that CA does not repair the trust boundary. Minimize any overlap: an exposed
old CA remains dangerous while clients still trust it.

Plan an approved maintenance window or staged trust overlap, retain only secure
non-compromised rollback material, and test Linux, Node, Rust, Android native,
and Android WebView paths separately. History/artifact cleanup is separate from
rotation and must be coordinated with repository owners; this change removes no
tracked files and performs no live rotation. The provisioning script deliberately
has no in-place overwrite or CA-reuse mode.

## Offline regression tests

From the repository root:

```sh
sh -n scripts/provision-core-tls.sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/tls -p 'test_*.py' -v
```

Tests require OpenSSL 3 and Python 3. They generate disposable real keys beneath a
private `/tmp` directory (not in the checkout), then clean up. They verify strict
chain/purpose, DNS/IP matching, wrong-name/wrong-IP/unknown-root rejection,
certificate profiles, permissions, no overwrite, argument injection rejection,
Git/symlink guards, and cleanup after an OpenSSL failure. They do not contact Core,
clients, or any external services and are not deployment-health acceptance.
