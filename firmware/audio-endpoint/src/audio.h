#ifndef AE_AUDIO_H
#define AE_AUDIO_H

#include <stdint.h>
#include <stdbool.h>
#include "protocol.h"

/* Bring up PIO, DMA and the ring buffers. Returns true on success. */
bool ae_audio_init(void);

/*
 * Pop one 8-channel mic frame (AE_MIC_FRAME_BYTES) into `out`.
 * Non-blocking: returns the number of bytes written (0 if no frame is ready).
 */
uint32_t ae_audio_read_mic(uint8_t *out, uint32_t max);

/*
 * Queue mono PCM16 playback for the DAC. Non-blocking: returns the number of
 * bytes accepted (may be less than `len` if the ring is full).
 */
uint32_t ae_audio_write_play(const uint8_t *data, uint32_t len);

/* Set the playback sample rate; reconfigures the output PIO clock divider. */
void ae_audio_set_play_rate(uint32_t rate);

/* Current playback sample rate. */
uint32_t ae_audio_play_rate(void);

/* Monotonic count of raw PIO words captured (diagnostic). */
uint32_t ae_audio_raw_words(void);

/* Monotonic count of network frames produced by the pump (diagnostic). */
uint32_t ae_audio_frames_produced(void);

/* Monotonic count of mono samples accepted into the play ring (diagnostic). */
uint32_t ae_audio_play_samples_written(void);

/* Monotonic count of 32-bit words the output DMA has read (diagnostic). */
uint32_t ae_audio_play_dma_words(void);

/* Queue silence ahead of the output DMA so it never loops stale audio. */
void ae_audio_fill_silence(void);

#endif /* AE_AUDIO_H */
