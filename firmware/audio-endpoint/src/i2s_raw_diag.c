#ifndef AE_RAW_I2S_DIAG
#error "This file belongs only to the opt-in raw-I2S diagnostic target"
#endif

#include "config.h"

#include "pico/stdlib.h"
#include "pico/stdio_usb.h"
#include "hardware/clocks.h"
#include "hardware/dma.h"
#include "hardware/irq.h"
#include "hardware/pio.h"

#include "i2s_raw_diag.pio.h"

#include <stdio.h>

#define DIAG_SAMPLE_RATE_HZ 16000u
#define DIAG_CLOCK_WARMUP_MS 250u
#define DIAG_OBSERVATIONS 8192u

/* 32 KiB bounded capture: 8192 separate GPIO snapshots, each stored as uint32. */
static uint32_t s_capture[DIAG_OBSERVATIONS] __attribute__((aligned(4)));
static int s_dma_channel = -1;
static volatile bool s_capture_done;

static void __isr dma_capture_irq(void) {
  dma_hw->ints0 = 1u << (uint)s_dma_channel;
  s_capture_done = true;
}

static void fail(const char *message) {
  printf("ERROR %s\n", message);
  fflush(stdout);
  while (true) tight_loop_contents();
}

int main(void) {
  stdio_init_all();
  sleep_ms(2000);
  /* Give the host a bounded window to open USB CDC before the one-shot capture. */
  for (uint32_t i = 0; i < 1500u && !stdio_usb_connected(); ++i) sleep_ms(10);
  printf("AE_RAW_I2S_V1 rate_hz=%u bclk_hz=%u warmup_ms=%u observations=%u bytes_per_observation=4\n",
         DIAG_SAMPLE_RATE_HZ, DIAG_SAMPLE_RATE_HZ * 64u, DIAG_CLOCK_WARMUP_MS, DIAG_OBSERVATIONS);
  printf("encoding=each_word_top6_bits_gpio0_to5;bit0=D0,bit1=D1,bit2=D2,bit3=D3,bit4=WS,bit5=CK;index_even=CK_high,index_odd=CK_low\n");
  printf("capture_is_one_shot;clock_generator_matches_production_32bit_slots;no_wifi_tcp_dsp_pcm_conversion_or_playback\n");
  fflush(stdout);

  PIO pio = pio0;
  if (!pio_can_add_program(pio, &raw_i2s_clock_program) ||
      !pio_can_add_program(pio, &raw_i2s_probe_program)) {
    fail("PIO instruction memory unavailable");
  }
  uint clock_offset = pio_add_program(pio, &raw_i2s_clock_program);
  uint probe_offset = pio_add_program(pio, &raw_i2s_probe_program);
  /* Claim the input SM first and clock SM second, as production does. The
   * higher-numbered clock SM must win PIO pin-direction priority for WS/CK. */
  int probe_sm_i = pio_claim_unused_sm(pio, false);
  int clock_sm_i = pio_claim_unused_sm(pio, false);
  if (clock_sm_i < 0 || probe_sm_i < 0) fail("PIO state machine unavailable");
  uint clock_sm = (uint)clock_sm_i;
  uint probe_sm = (uint)probe_sm_i;

  /* Configure the input SM's pin directions first, then configure the clock
   * SM as GPIO output, matching production's pin ownership order. */
  pio_sm_config probe_config = raw_i2s_probe_program_get_default_config(probe_offset);
  sm_config_set_in_pins(&probe_config, AE_PIN_MIC_D0);
  sm_config_set_in_shift(&probe_config, true, false, 32);
  sm_config_set_fifo_join(&probe_config, PIO_FIFO_JOIN_RX);
  for (uint pin = AE_PIN_MIC_D0; pin <= AE_PIN_MIC_D3; ++pin) pio_gpio_init(pio, pin);
  pio_sm_set_consecutive_pindirs(pio, probe_sm, AE_PIN_MIC_D0, 5, false);

  pio_sm_config clock_config = raw_i2s_clock_program_get_default_config(clock_offset);
  sm_config_set_sideset_pins(&clock_config, AE_PIN_MIC_WS);
  pio_gpio_init(pio, AE_PIN_MIC_WS);
  pio_gpio_init(pio, AE_PIN_MIC_CK);
  pio_sm_set_consecutive_pindirs(pio, clock_sm, AE_PIN_MIC_WS, 2, true);
  pio_sm_init(pio, clock_sm, clock_offset, &clock_config);
  const float clock_divider = (float)clock_get_hz(clk_sys) /
      (float)(DIAG_SAMPLE_RATE_HZ * 64u * 2u);
  pio_sm_set_clkdiv(pio, clock_sm, clock_divider);

  s_dma_channel = dma_claim_unused_channel(false);
  if (s_dma_channel < 0) fail("DMA channel unavailable");
  dma_channel_config dma_config = dma_channel_get_default_config((uint)s_dma_channel);
  channel_config_set_transfer_data_size(&dma_config, DMA_SIZE_32);
  channel_config_set_read_increment(&dma_config, false);
  channel_config_set_write_increment(&dma_config, true);
  channel_config_set_dreq(&dma_config, pio_get_dreq(pio, probe_sm, false));
  dma_channel_set_irq0_enabled((uint)s_dma_channel, true);
  irq_set_exclusive_handler(DMA_IRQ_0, dma_capture_irq);
  irq_set_enabled(DMA_IRQ_0, true);

  uint32_t clock_divider_milli = (uint32_t)(clock_divider * 1000.0f + 0.5f);
  printf("READY sys_clk_hz=%u clock_divider_milli=%lu; capture starts immediately after this line\n",
         clock_get_hz(clk_sys), (unsigned long)clock_divider_milli);
  fflush(stdout);

  /* Warm the microphone's internal digital filter while keeping the clock
   * continuous, then start the unsynchronized probe and bounded DMA capture. */
  dma_channel_configure((uint)s_dma_channel, &dma_config, s_capture,
                        &pio->rxf[probe_sm], DIAG_OBSERVATIONS, true);
  pio_sm_set_enabled(pio, clock_sm, true);
  sleep_ms(DIAG_CLOCK_WARMUP_MS);
  pio_sm_init(pio, probe_sm, probe_offset, &probe_config);
  pio_sm_set_enabled(pio, probe_sm, true);

  while (!s_capture_done) tight_loop_contents();
  pio_sm_set_enabled(pio, probe_sm, false);
  pio_sm_set_enabled(pio, clock_sm, false);
  dma_channel_set_irq0_enabled((uint)s_dma_channel, false);
  irq_set_enabled(DMA_IRQ_0, false);

  printf("CAPTURE_COMPLETE observations=%u\n", DIAG_OBSERVATIONS);
  for (uint32_t i = 0; i < DIAG_OBSERVATIONS; ++i) {
    printf("%08lx\n", (unsigned long)s_capture[i]);
  }
  printf("CAPTURE_END\n");
  fflush(stdout);

  /* Stay stopped until reset so each run corresponds to one fresh capture. */
  while (true) tight_loop_contents();
}
