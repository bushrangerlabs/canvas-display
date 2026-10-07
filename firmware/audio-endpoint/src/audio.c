#include "audio.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/clocks.h"
#include "hardware/irq.h"

#include "i2s_output.pio.h"
#include "i2s_input.pio.h"

/* ------------------------------------------------------------------ */
/* Sizing                                                              */
/* ------------------------------------------------------------------ */

/* The PIO pushes a 32-bit word every 8 MIC_CK cycles (8 bits x 4 lanes).
 * One I2S frame = 64 MIC_CK = 8 words. One network frame = 320 I2S frames. */
#define RAW_WORDS_PER_I2S_FRAME 8u
#define RAW_WORDS_PER_NET_FRAME (AE_MIC_FRAME_SAMPLES * RAW_WORDS_PER_I2S_FRAME) /* 2560 */

#define MIC_FRAME_RING 4u

/* DMA rings must be a power of two in bytes. */
#define RAW_RING_WORDS 8192u  /* 32 KB */
#define PLAY_RING_WORDS 4096u /* 16 KB */

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

static PIO s_pio = pio0;
static uint s_sm_in, s_sm_out, s_sm_clk;
static int s_dma_in = -1, s_dma_out = -1;

/* Raw PIO words, written by the input DMA (ring). */
static uint32_t s_raw[RAW_RING_WORDS] __attribute__((aligned(RAW_RING_WORDS * 4)));
static uint32_t s_raw_last_idx; /* last DMA write index, for monotonic tracking */
static uint32_t s_raw_total;    /* monotonic words written by the DMA */

/* De-interleaved 8-channel network frames. */
static uint8_t s_mic_frames[MIC_FRAME_RING][AE_MIC_FRAME_BYTES] __attribute__((aligned(4)));
static volatile uint32_t s_mic_head, s_mic_tail;
static uint32_t s_raw_frames_consumed; /* monotonic raw frames pulled from the ring */

/* Playback ring, read by the output DMA (ring). */
static uint32_t s_play[PLAY_RING_WORDS] __attribute__((aligned(PLAY_RING_WORDS * 4)));
static volatile uint32_t s_play_write_words; /* words the CPU has written (monotonic) */
static uint32_t s_play_last_idx; /* last DMA read index, for monotonic tracking */
static uint32_t s_play_total;    /* monotonic words read by the DMA */

static uint32_t s_play_rate = 22050u;

/* ------------------------------------------------------------------ */
/* De-interleave                                                       */
/* ------------------------------------------------------------------ */

/* Extract one lane's byte (MSB = first MIC_CK bit) from a 32-bit PIO word. */
static inline uint8_t lane_byte(uint32_t word, int lane) {
  uint8_t b = 0;
  for (int i = 7; i >= 0; i--) {
    b = (uint8_t)((b << 1) | ((word >> (4 * i + lane)) & 1u));
  }
  return b;
}

/* Convert one I2S frame (8 raw words) into 8 interleaved int16 samples. */
static inline void i2s_frame_to_samples(const uint32_t *w, int16_t *out8) {
  /* w[0..3] = left slot (CK 0..31), w[4..7] = right slot (CK 32..63).
   * We keep the top 16 bits of each 32-bit slot (24-bit mic data, MSB-aligned). */
  for (int lane = 0; lane < 4; lane++) {
    int16_t left  = (int16_t)((lane_byte(w[0], lane) << 8) | lane_byte(w[1], lane));
    int16_t right = (int16_t)((lane_byte(w[4], lane) << 8) | lane_byte(w[5], lane));
    out8[lane * 2 + 0] = left;
    out8[lane * 2 + 1] = right;
  }
}

/* ------------------------------------------------------------------ */
/* Pump: raw words -> network frames                                   */
/* ------------------------------------------------------------------ */

/* Monotonic count of words the input DMA has written, derived from its ring
 * write pointer. Must be called often enough that the DMA never wraps more
 * than once between calls (32 KB ring, ~128 k words/s -> ~64 ms). */
static uint32_t raw_dma_words(void) {
  uint32_t addr = (uint32_t)dma_channel_hw_addr(s_dma_in)->write_addr;
  uint32_t idx = (addr - (uint32_t)s_raw) / 4u;
  uint32_t delta = (idx + RAW_RING_WORDS - s_raw_last_idx) % RAW_RING_WORDS;
  s_raw_total += delta;
  s_raw_last_idx = idx;
  return s_raw_total;
}

/* Monotonic count of words the output DMA has read. */
static uint32_t play_dma_words(void) {
  uint32_t addr = (uint32_t)dma_channel_hw_addr(s_dma_out)->read_addr;
  uint32_t idx = (addr - (uint32_t)s_play) / 4u;
  uint32_t delta = (idx + PLAY_RING_WORDS - s_play_last_idx) % PLAY_RING_WORDS;
  s_play_total += delta;
  s_play_last_idx = idx;
  return s_play_total;
}

void ae_audio_pump(void);

void ae_audio_pump(void) {
  uint32_t written = raw_dma_words();
  uint32_t available = written - s_raw_frames_consumed * RAW_WORDS_PER_NET_FRAME;
  while (available >= RAW_WORDS_PER_NET_FRAME) {
    uint32_t next = (s_mic_head + 1u) % MIC_FRAME_RING;
    if (next == s_mic_tail) break; /* frame ring full */

    uint8_t *dst = s_mic_frames[s_mic_head];
    int16_t *samples = (int16_t *)dst;
    uint32_t base = (s_raw_frames_consumed * RAW_WORDS_PER_NET_FRAME) % RAW_RING_WORDS;

    for (uint32_t f = 0; f < AE_MIC_FRAME_SAMPLES; f++) {
      uint32_t idx = (base + f * RAW_WORDS_PER_I2S_FRAME) % RAW_RING_WORDS;
      uint32_t w[8];
      for (int k = 0; k < 8; k++) w[k] = s_raw[(idx + k) % RAW_RING_WORDS];
      i2s_frame_to_samples(w, &samples[f * AE_MIC_CHANNELS]);
    }

    s_mic_head = next;
    s_raw_frames_consumed++;
    available = written - s_raw_frames_consumed * RAW_WORDS_PER_NET_FRAME;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

uint32_t ae_audio_read_mic(uint8_t *out, uint32_t max) {
  if (max < AE_MIC_FRAME_BYTES) return 0;
  ae_audio_pump();
  if (s_mic_head == s_mic_tail) return 0;
  for (uint32_t i = 0; i < AE_MIC_FRAME_BYTES; i++) out[i] = s_mic_frames[s_mic_tail][i];
  s_mic_tail = (s_mic_tail + 1u) % MIC_FRAME_RING;
  return AE_MIC_FRAME_BYTES;
}

uint32_t ae_audio_write_play(const uint8_t *data, uint32_t len) {
  const int16_t *pcm = (const int16_t *)data;
  uint32_t samples = len / 2u;
  uint32_t accepted = 0;

  /* DMA read position within the ring (exact, no aliasing — the ring wraps
   * many times between calls, so a monotonic counter would undercount). */
  uint32_t read_pos = ((uint32_t)dma_channel_hw_addr(s_dma_out)->read_addr - (uint32_t)s_play) / 4u;

  for (uint32_t i = 0; i < samples; i++) {
    /* Keep two words of slack so the DMA read pointer never catches the writer. */
    uint32_t write_pos = s_play_write_words % PLAY_RING_WORDS;
    uint32_t used = (write_pos + PLAY_RING_WORDS - read_pos) % PLAY_RING_WORDS;
    if (used + 2u >= PLAY_RING_WORDS) break;

    /* Mono -> stereo: duplicate the sample into both 32-bit slots.
     * The UDA1334A uses I2S-bus format: the MSB is delayed one BCLK after WS,
     * so a 16-bit sample must sit in bits 15..30 (bit 31 is the pre-MS delay
     * slot, read as 0). Placing it at bits 16..31 (left-justified) made the
     * DAC read every sample shifted by one bit, losing the sign bit and
     * producing the loud hiss. */
    uint32_t word = ((uint32_t)(uint16_t)pcm[i]) << 15;
    s_play[s_play_write_words % PLAY_RING_WORDS] = word;
    s_play[(s_play_write_words + 1u) % PLAY_RING_WORDS] = word;
    s_play_write_words += 2u;
    accepted += 2u;
  }
  return accepted;
}

void ae_audio_set_play_rate(uint32_t rate) {
  if (rate < AE_PLAY_MIN_RATE) rate = AE_PLAY_MIN_RATE;
  if (rate > AE_PLAY_MAX_RATE) rate = AE_PLAY_MAX_RATE;
  s_play_rate = rate;
  /* One frame = 2 slots; each slot is 1 `set` + 31 `out`/`jmp` pairs = 63 PIO
   * cycles, so a frame is 126 cycles and produces 62 BCLK cycles. Match the
   * actual cycle count so LRCK lands at exactly `rate` Hz. */
  float div = (float)clock_get_hz(clk_sys) / (float)(rate * 126u);
  pio_sm_set_clkdiv(s_pio, s_sm_out, div);
}

uint32_t ae_audio_play_rate(void) { return s_play_rate; }

uint32_t ae_audio_raw_words(void) { return raw_dma_words(); }

uint32_t ae_audio_frames_produced(void) { return s_raw_frames_consumed; }

uint32_t ae_audio_play_samples_written(void) { return s_play_write_words; }

uint32_t ae_audio_play_dma_words(void) { return play_dma_words(); }

/* Keep a little silence queued ahead of the output DMA so that when playback
 * data stops (burst ends or connection closes) the ring DMA reads zeros instead
 * of looping the last ~93 ms of audio forever. Called from the main loop under
 * the lwIP lock so it cannot race the background ae_audio_write_play. */
void ae_audio_fill_silence(void) {
  uint32_t read_pos = ((uint32_t)dma_channel_hw_addr(s_dma_out)->read_addr - (uint32_t)s_play) / 4u;
  uint32_t write_pos = s_play_write_words % PLAY_RING_WORDS;
  uint32_t used = (write_pos + PLAY_RING_WORDS - read_pos) % PLAY_RING_WORDS;
  /* ~2 ms of silence at 22050 Hz (44.1 k words/s). */
  const uint32_t target = 88u;
  while (used < target) {
    s_play[s_play_write_words % PLAY_RING_WORDS] = 0;
    s_play_write_words++;
    write_pos = s_play_write_words % PLAY_RING_WORDS;
    used = (write_pos + PLAY_RING_WORDS - read_pos) % PLAY_RING_WORDS;
  }
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

static void dma_in_handler(void);

static void dma_in_handler(void) {
  dma_hw->ints0 = 1u << s_dma_in; /* clear */
  /* The input DMA runs in a ring; nothing to restart. */
}

__attribute__((unused)) static void ae_audio_keep_handler(void) { dma_in_handler(); }

bool ae_audio_init(void) {
  /* --- Output: I2S master to the DAC --- */
  if (!pio_can_add_program(s_pio, &i2s_out_program)) return false;
  uint off_out = pio_add_program(s_pio, &i2s_out_program);
  s_sm_out = pio_claim_unused_sm(s_pio, false);
  if (s_sm_out < 0) return false;

  pio_sm_config c_out = i2s_out_program_get_default_config(off_out);
  sm_config_set_sideset_pins(&c_out, AE_PIN_DAC_BCLK); /* BCLK, LRCK */
  sm_config_set_out_pins(&c_out, AE_PIN_DAC_DIN, 1);
  sm_config_set_out_shift(&c_out, false, true, 32);    /* MSB first, autopull */
  sm_config_set_fifo_join(&c_out, PIO_FIFO_JOIN_TX);
  pio_gpio_init(s_pio, AE_PIN_DAC_BCLK);
  pio_gpio_init(s_pio, AE_PIN_DAC_LRCK);
  pio_gpio_init(s_pio, AE_PIN_DAC_DIN);
  pio_sm_set_consecutive_pindirs(s_pio, s_sm_out, AE_PIN_DAC_BCLK, 2, true);
  pio_sm_set_consecutive_pindirs(s_pio, s_sm_out, AE_PIN_DAC_DIN, 1, true);
  pio_sm_init(s_pio, s_sm_out, off_out, &c_out);
  ae_audio_set_play_rate(s_play_rate);
  pio_sm_set_enabled(s_pio, s_sm_out, true);

  /* --- Input: 4-lane I2S from the mic array --- */
  if (!pio_can_add_program(s_pio, &i2s_in_4lane_program)) return false;
  uint off_in = pio_add_program(s_pio, &i2s_in_4lane_program);
  s_sm_in = pio_claim_unused_sm(s_pio, false);
  if (s_sm_in < 0) return false;

  pio_sm_config c_in = i2s_in_4lane_program_get_default_config(off_in);
  sm_config_set_in_pins(&c_in, AE_PIN_MIC_D0);
  sm_config_set_in_shift(&c_in, false, true, 32); /* shift left, autopush at 32 */
  sm_config_set_fifo_join(&c_in, PIO_FIFO_JOIN_RX);
  for (int p = AE_PIN_MIC_D0; p <= AE_PIN_MIC_D3; p++) pio_gpio_init(s_pio, p);
  pio_sm_set_consecutive_pindirs(s_pio, s_sm_in, AE_PIN_MIC_D0, 4, false);

#if AE_MIC_I2S_MASTER
  /* The array is a slave: generate MIC_CK/MIC_WS ourselves. */
  if (!pio_can_add_program(s_pio, &i2s_clk_gen_program)) return false;
  uint off_clk = pio_add_program(s_pio, &i2s_clk_gen_program);
  s_sm_clk = pio_claim_unused_sm(s_pio, false);
  if (s_sm_clk < 0) return false;
  pio_sm_config c_clk = i2s_clk_gen_program_get_default_config(off_clk);
  sm_config_set_sideset_pins(&c_clk, AE_PIN_MIC_WS); /* WS, CK */
  pio_gpio_init(s_pio, AE_PIN_MIC_WS);
  pio_gpio_init(s_pio, AE_PIN_MIC_CK);
  pio_sm_set_consecutive_pindirs(s_pio, s_sm_clk, AE_PIN_MIC_WS, 2, true);
  pio_sm_init(s_pio, s_sm_clk, off_clk, &c_clk);
  /* CK = clk_sys / (2 * div); want CK = rate * 64. */
  float div = (float)clock_get_hz(clk_sys) / (float)(AE_MIC_SAMPLE_RATE * 64u * 2u);
  pio_sm_set_clkdiv(s_pio, s_sm_clk, div);
  pio_sm_set_enabled(s_pio, s_sm_clk, true);
#else
  /* The array drives MIC_CK/MIC_WS; just read them. */
  pio_gpio_init(s_pio, AE_PIN_MIC_CK);
  pio_gpio_init(s_pio, AE_PIN_MIC_WS);
  pio_sm_set_consecutive_pindirs(s_pio, s_sm_in, AE_PIN_MIC_CK, 1, false);
  pio_sm_set_consecutive_pindirs(s_pio, s_sm_in, AE_PIN_MIC_WS, 1, false);
  s_sm_clk = -1;
#endif

  pio_sm_init(s_pio, s_sm_in, off_in, &c_in);
  pio_sm_set_enabled(s_pio, s_sm_in, true);

  /* --- Input DMA: PIO RX FIFO -> raw ring (wrapping) --- */
  s_dma_in = dma_claim_unused_channel(false);
  if (s_dma_in < 0) return false;
  {
    dma_channel_config d = dma_channel_get_default_config(s_dma_in);
    channel_config_set_transfer_data_size(&d, DMA_SIZE_32);
    channel_config_set_read_increment(&d, false);  /* PIO RX FIFO */
    channel_config_set_write_increment(&d, true);
    channel_config_set_ring(&d, true, 15);         /* wrap writes within 32 KB */
    channel_config_set_dreq(&d, pio_get_dreq(s_pio, s_sm_in, false));
    dma_channel_configure(s_dma_in, &d, s_raw, &s_pio->rxf[s_sm_in], 0xFFFFFFFFu, true);
  }

  /* --- Output DMA: play ring -> PIO TX FIFO (wrapping) --- */
  s_dma_out = dma_claim_unused_channel(false);
  if (s_dma_out < 0) return false;
  {
    dma_channel_config d = dma_channel_get_default_config(s_dma_out);
    channel_config_set_transfer_data_size(&d, DMA_SIZE_32);
    channel_config_set_read_increment(&d, true);
    channel_config_set_write_increment(&d, false); /* PIO TX FIFO */
    channel_config_set_ring(&d, false, 14);        /* wrap reads within 16 KB */
    channel_config_set_dreq(&d, pio_get_dreq(s_pio, s_sm_out, true));
    dma_channel_configure(s_dma_out, &d, &s_pio->txf[s_sm_out], s_play, 0xFFFFFFFFu, true);
  }

  return true;
}
