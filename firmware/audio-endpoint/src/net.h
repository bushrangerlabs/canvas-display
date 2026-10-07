#ifndef AE_NET_H
#define AE_NET_H

#include <stdint.h>
#include <stdbool.h>
#include "protocol.h"

/* Start the TCP server on AE_DEFAULT_PORT. */
bool ae_net_init(void);

/* Drive the server: accept connections, pump mic frames out, playback in.
 * Call frequently from the main loop. */
void ae_net_poll(void);

/* Connection status. */
bool ae_net_mic_connected(void);
bool ae_net_playback_connected(void);

/* Requested voice state, or READY without a current MIC owner.
 * Call with the lwIP lock held; rendering belongs outside the lock. */
enum ae_voice_state ae_net_voice_state(void);

/* Set the per-endpoint token the edge must present (issued by Core). */
void ae_net_set_token(const char *token);

/* Current endpoint token (used for Core heartbeat auth). */
const char *ae_net_token(void);

#endif /* AE_NET_H */
