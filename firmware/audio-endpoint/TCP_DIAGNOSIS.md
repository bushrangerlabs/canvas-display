# Audio endpoint TCP lifecycle diagnosis

## Accepted status

**CONFIRMED:** unsynchronized application raw-lwIP access caused the original
queue corruption. Synchronization-only validation passed 101/101 sessions;
the subsequent lifecycle build passed 131/131, including 30/30 harsher closes
with queued audio. No assertions, panics, observed resets, transmit ERR_MEM,
unexpected stalls or context-slot leaks were observed. Send queue length stayed
bounded and tcp_sndbuf never exceeded its configured maximum.

**IMPLEMENTED BUT NOT LIVE-EXERCISED:** application retry/ownership handling for
an actual returned tcp_close ERR_MEM. Coverage limitations are documented below;
no further artificial memory-pressure experiments are requested.

Assertions, watchdog, synchronization and corrected lifecycle are preserved.
Transport is accepted as stable; reopen only on new end-to-end failure evidence.
A logging-only build disables verbose per-ACK/idle-wait tracing by default
(`AE_TCP_VERBOSE_DIAGNOSTICS=0`) while retaining lifecycle and error diagnostics.
It compiles but is not yet flashed. All evidence logs below remain unchanged.

## Confirmed send-queue corruption fix (2026-10-05)

The previous `tcp_receive: valid queue length` assertion, `snd_queuelen=65535`, impossible `tcp_sndbuf()` values above 11680, and subsequent transmit `ERR_MEM` failures were caused by application-context raw lwIP calls without the required `cyw43_arch_lwip_begin()` / `cyw43_arch_lwip_end()` synchronization while using `pico_cyw43_arch_lwip_threadsafe_background`.

The synchronization-only change in `src/main.c` protects server initialization, initial registration, the entire networking poll/session-check block, heartbeat requests, and connection-status snapshots. Callback-context operations remain within lwIP's existing callback protection. No audio, frame, buffer, watchdog, assertion, or teardown changes were included in this experiment.

Evidence: `sync-diagnostics.log` (preserve this baseline separately from subsequent tests).

- One initial Core mic test plus 100 rapid connect/stream/disconnect cycles.
- 101 accepts, 101 successful authentications, 101 sessions with ACKed audio, 101 FIN events, 101 closes.
- Minimum ACKed bytes per session: 15398 (5-byte auth response plus three 5131-byte mic frames).
- Zero panics, zero reboot messages, zero logged transmit ERR_MEM.
- Maximum observed send queue length: 9; maximum observed send buffer: 11680 (configured maximum).
- No silent streaming stall observed. Reset count is inferred from boot messages/session numbering, not a hardware reset-cause register.

Earlier claims that this was proven to be an upstream lwIP bug, a CYW43 driver failure, or that disabling assertions fixes it are superseded. Assertions remain ENABLED; the watchdog remains enabled.

## Isolated graceful-close correction (built, flashed, runtime-tested)

Previous `conn_close()` detached some callbacks, ignored `tcp_close()`'s result, and immediately freed its context slot. The sent callback was not explicitly detached, though clearing `tcp_arg()` made it receive NULL.

Installed SDK source: `pico-sdk/lib/lwip/src/core/tcp.c`, `tcp_close()`, `tcp_close_shutdown_fin()`, and `tcp_fasttmr()`.

- The documented raw API allows an actual returned ERR_MEM to be retried from ACK or polling callbacks.
- This installed lwIP 2.2.1 additionally converts FIN-allocation ERR_MEM into ERR_OK and sets TF_CLOSEPEND. Its timer retries internally. ERR_OK transfers ownership to lwIP; application code must not subsequently inspect the PCB, even if wire-level close is still pending.

Small lifecycle correction in `src/net.c`:

1. Mark the context closing and remove it from active mic/playback ownership; stop further application sends.
2. Detach arg, recv, sent, err, and poll callbacks BEFORE invoking tcp_close, because success may free/transfer the PCB immediately.
3. On ERR_OK, release the context; do not access the PCB again. lwIP owns any remaining queued audio and FIN processing.
4. On failure (including actual returned ERR_MEM), retain the context and PCB, restore callbacks, and install a tcp_poll retry with interval 2 (approximately one second). No main-loop retry and no automatic abort.
5. Error callbacks release the retained context after lwIP has destroyed the PCB; they never dereference the destroyed PCB.
6. Received data on a retained closing context is acknowledged/discarded, not processed as a new session. PCB-bearing callbacks assert context ownership.

Diagnostics distinguish CLOSE REQUEST, tcp_close result, CLOSE RETRY, CLOSE RELEASE / ERROR RELEASE with occupied-slot counts, and the existing no-free-context rejection abort path.

The synchronization fix, audio path, packet sizes, buffers, playback, protocol, watchdog, and assertion configuration are unchanged.

### Isolated teardown validation

Firmware built and flashed with assertions enabled. One normal Core mic test, 100 rapid Core mic-test cycles, then 30 outstanding-audio teardown cycles completed without changing any other firmware subsystem.

Evidence files:
- `close-single.log`: initial connection lifecycle.
- `close-diagnostics.log`: complete normal + outstanding-audio lifecycle capture.
- `close-test-results.json`: per-test client results and aggregated measurements.
- `sync-diagnostics.log`: earlier synchronization-only baseline, unchanged.

| Measurement | Initial + 100 normal tests | Total including 30 outstanding-audio tests |
|---|---:|---:|
| Client pass/fail | 101/0 | 131/0 |
| ACCEPT / AUTH OK | 101 / 101 | 131 / 131 |
| ACK callback events | 1166 | 1226 |
| RX FIN / CLOSE REQUEST / close ERR_OK | 101 / 101 / 101 | 131 / 131 / 131 |
| Returned close ERR_MEM / close retries | 0 / 0 | 0 / 0 |
| Application aborts | 0 | 0 |
| Panics / reboot messages | 0 / 0 | 0 / 0 |
| Logged transmit ERR_MEM | 0 | 0 |
| Maximum observed snd_queuelen | 9 | 19 |
| Maximum observed tcp_sndbuf | 11680 | 11680 |
| Occupied slots after each release | 0 | 0 |

Outstanding-audio test: authenticate a raw TCP mic client with a 1024-byte requested receive buffer; stop reading for 150 ms while audio queues, then send FIN by shutting down the write side and drain until EOF. All 30 closes had qlen=18 at CLOSE REQUEST and drained 10262 audio bytes (two complete mic frames) before EOF. Example: session 102 closed with sndbuf=1994, qlen=18, slots=1; tcp_close returned ERR_OK and released the context with slots=0.

No context-slot leak or unexpected silent stream stall was observed. Zero watchdog resets were observed through boot messages and monotonic sessions; reset cause was not read from hardware. Returned ERR_MEM and the application poll-retry branch were NOT exercised by these live tests. Internal TF_CLOSEPEND retries, if any, are not counted by application diagnostics after ownership transfers to lwIP. Do not claim coverage of either memory-pressure path from successful close results alone.
