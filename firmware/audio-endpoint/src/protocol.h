#ifndef AE_PROTOCOL_H
#define AE_PROTOCOL_H

#include <stdint.h>

/*
 * Canvas Audio Endpoint wire protocol (v1).
 *
 * Transport: TCP. The endpoint runs a server; the edge opens two connections:
 *   - MIC connection:      endpoint -> edge, continuous 8-channel PCM
 *   - PLAYBACK connection: edge -> endpoint, PCM at a negotiated rate
 *
 * Every message is length-prefixed:
 *   [u16 payload_len (LE)][u8 type][payload ...]
 * payload_len counts the type byte plus the payload.
 *
 * All multi-byte integers are little-endian (both ends are LE).
 */

#define AE_PROTOCOL_VERSION 1u

/* Default TCP port the endpoint listens on. */
#define AE_DEFAULT_PORT 8090

/* Microphone: 7 mics presented as 8 interleaved channels @ 16 kHz.
 * The Sipeed R6+1 array exposes 4 stereo I2S data lines (D0..D3):
 *   D0 = mic0+mic1, D1 = mic2+mic3, D2 = mic4+mic5, D3 = centre mic only.
 * D3's left slot is unused (reads ~0); the centre mic is on the right slot,
 * so channel 7 is the centre mic and channel 6 is the spare. */
#define AE_MIC_CHANNELS 8
#define AE_MIC_SAMPLE_RATE 16000u
#define AE_MIC_FRAME_MS 20u
#define AE_MIC_FRAME_SAMPLES (AE_MIC_SAMPLE_RATE * AE_MIC_FRAME_MS / 1000u) /* 320 */
#define AE_MIC_FRAME_BYTES (AE_MIC_FRAME_SAMPLES * AE_MIC_CHANNELS * 2u)    /* 5120 */

/* Playback: mono PCM16 at a rate chosen by the edge (22050 TTS, 48000 music). */
#define AE_PLAY_CHANNELS 1
#define AE_PLAY_MIN_RATE 8000u
#define AE_PLAY_MAX_RATE 48000u

/* Message types. */
enum ae_msg_type {
  AE_MSG_HELLO     = 1, /* edge -> endpoint: auth + identity */
  AE_MSG_HELLO_ACK = 2, /* endpoint -> edge: accepted */
  AE_MSG_CONFIG    = 3, /* edge -> endpoint: playback format */
  AE_MSG_AUDIO     = 4, /* both directions: PCM frame */
  AE_MSG_PING      = 5,
  AE_MSG_PONG      = 6,
  AE_MSG_ERROR     = 7,
  AE_MSG_VOICE_STATE = 8, /* authenticated current MIC owner -> endpoint */
};

/*
 * Payload layouts:
 *   HELLO      [u8 role][u8 token_len][token][u8 device_id_len][device_id]
 *              role: 0 = mic (endpoint -> edge), 1 = playback (edge -> endpoint)
 *   HELLO_ACK  [u8 version][u8 status]           status: 0=ok, 1=bad_token
 *   CONFIG     [u32 sample_rate][u8 channels][u8 format]   format: 0=PCM16
 *   AUDIO mic  [u32 seq][u32 ts_ms][PCM16 x N]   N = samples * 8 channels
 *   AUDIO play [PCM16 x N]                        N = samples * 1 channel
 *   ERROR      [u8 code][u8 msg_len][msg]
 *   VOICE_STATE [u8 state]                     exactly one byte, values below
 */

enum ae_voice_state {
  AE_VOICE_READY = 0,      /* blue */
  AE_VOICE_LISTENING = 1,  /* green */
  AE_VOICE_PROCESSING = 2, /* processing/speaking: amber */
  AE_VOICE_ERROR = 3,      /* red */
};

/* HELLO roles. */
enum ae_role {
  AE_ROLE_MIC = 0,
  AE_ROLE_PLAYBACK = 1,
};

#define AE_MAX_FRAME_PAYLOAD 8192u

#endif /* AE_PROTOCOL_H */
