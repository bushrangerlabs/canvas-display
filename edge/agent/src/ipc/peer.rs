//! Peer identity: who is really on the other end of a Unix domain socket connection.
//!
//! Production trust must never be derived from anything the peer says about itself. On Linux the
//! kernel-verified equivalent is `SO_PEERCRED`: immediately after `accept()`, the listening
//! process can ask the kernel "which uid/gid/pid actually holds the other end of this socket,"
//! and the kernel's answer cannot be forged by the connecting process. [`SoPeercredSource`] is the
//! real implementation of that call.
//!
//! A single test process cannot easily simulate "a different OS user connected" over one real
//! socket without either running the test suite as multiple real system users (not viable in CI
//! sandboxes) or literally being root and using `setuid` tricks (fragile and invasive). Instead,
//! [`PeerCredentialSource`] is a small trait: production code always uses [`SoPeercredSource`],
//! and tests that need to simulate an unauthorized/other uid can supply
//! [`FakePeerCredentialSource`] instead. Exactly one test in this crate's test suite exercises the
//! real [`SoPeercredSource`] path end to end; see `tests/local_ipc_v1.rs`.

use std::io;
use std::mem;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;

/// The real transport equivalent of the TS model's `PeerCredential`: `SO_PEERCRED` uid/gid/pid.
///
/// `pid` is carried for audit/logging only. It is never used for any trust decision -- pids are
/// reused and a legitimate peer restart also gets a new pid, so treating pid as an identity would
/// be both wrong and pointless.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerCredential {
    pub uid: u32,
    pub gid: u32,
    pub pid: i32,
}

/// Resolves the real peer credential for an accepted Unix domain socket connection.
///
/// Implementations must never accept a self-reported role or identity from the peer; the only
/// production implementation ([`SoPeercredSource`]) reads a kernel-verified credential.
pub trait PeerCredentialSource {
    fn identify(&self, stream: &UnixStream) -> io::Result<PeerCredential>;
}

/// Production peer-credential source: reads the real, kernel-verified credential of the process
/// on the other end of `stream` via `getsockopt(SOL_SOCKET, SO_PEERCRED)`.
///
/// This is not spoofable by the connecting process: `SO_PEERCRED` is filled in by the kernel from
/// the socket's actual owning process at `connect()`/`accept()` time, not from anything the peer
/// writes to the socket.
#[derive(Debug, Default, Clone, Copy)]
pub struct SoPeercredSource;

impl PeerCredentialSource for SoPeercredSource {
    fn identify(&self, stream: &UnixStream) -> io::Result<PeerCredential> {
        let fd = stream.as_raw_fd();
        // SAFETY: `ucred` is a plain-old-data struct of three integers; zero-initializing it is
        // always valid, and `getsockopt` fully overwrites it on success.
        let mut ucred: libc::ucred = unsafe { mem::zeroed() };
        let mut len = mem::size_of::<libc::ucred>() as libc::socklen_t;

        // SAFETY: `fd` is a valid, open socket file descriptor owned by `stream` for the duration
        // of this call; `ucred`/`len` point at valid, correctly sized local storage.
        let result = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut ucred as *mut libc::ucred as *mut libc::c_void,
                &mut len,
            )
        };

        if result != 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(PeerCredential {
            uid: ucred.uid,
            gid: ucred.gid,
            pid: ucred.pid,
        })
    }
}

/// Test-only credential source that always returns a fixed, injected [`PeerCredential`],
/// regardless of who actually connected on the underlying stream. This is what makes it possible
/// to exercise "wrong uid" / "renderer vs. updater" scenarios in a single test process without
/// needing distinct real OS users.
///
/// Not used by any production code path.
#[derive(Debug, Clone, Copy)]
pub struct FakePeerCredentialSource {
    pub credential: PeerCredential,
}

impl FakePeerCredentialSource {
    pub fn new(uid: u32, gid: u32, pid: i32) -> Self {
        Self {
            credential: PeerCredential { uid, gid, pid },
        }
    }
}

impl PeerCredentialSource for FakePeerCredentialSource {
    fn identify(&self, _stream: &UnixStream) -> io::Result<PeerCredential> {
        Ok(self.credential)
    }
}
