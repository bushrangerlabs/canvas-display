#include "led.h"
#include "config.h"

#include "pico/stdlib.h"

/* SK9822: clocked, 32 bits per LED (0xE0|brightness, B, G, R), MSB first.
 * 12 LEDs on the Sipeed array. Bit-banged; the array is the only consumer of
 * these two pins, so timing is not critical. */

#define LED_COUNT 12

static ae_led_state_t s_state = AE_LED_BOOT;
static uint32_t s_last_ms;

static inline void sk_ck(int v) { gpio_put(AE_PIN_LED_CK, v); }
static inline void sk_da(int v) { gpio_put(AE_PIN_LED_DA, v); }

static void sk_send(uint32_t word) {
  for (int i = 31; i >= 0; i--) {
    sk_ck(0);
    sk_da((word >> i) & 1u);
    busy_wait_us(1);
    sk_ck(1);
    busy_wait_us(1);
  }
}

static void sk_show(uint8_t r, uint8_t g, uint8_t b, uint8_t bright) {
  sk_send(0x00000000u); /* start frame */
  uint32_t word = ((uint32_t)(0xE0u | (bright & 0x1Fu)) << 24) | ((uint32_t)b << 16) | ((uint32_t)g << 8) | r;
  for (int i = 0; i < LED_COUNT; i++) sk_send(word);
  sk_send(0xFFFFFFFFu); /* end frame */
}

void led_init(void) {
  gpio_init(AE_PIN_LED_CK);
  gpio_init(AE_PIN_LED_DA);
  gpio_set_dir(AE_PIN_LED_CK, GPIO_OUT);
  gpio_set_dir(AE_PIN_LED_DA, GPIO_OUT);
  sk_ck(0);
  sk_da(0);
}

void led_set(ae_led_state_t state) { s_state = state; }

void led_poll(void) {
  uint32_t now = to_ms_since_boot(get_absolute_time());
  if (now - s_last_ms < 250u) return;
  s_last_ms = now;

  switch (s_state) {
    case AE_LED_BOOT:      sk_show(0, 0, 40, 8); break;
    case AE_LED_WIFI:      sk_show(0, 40, 40, 8); break;
    case AE_LED_IDLE:      sk_show(0, 0, 12, 4); break;
    case AE_LED_LISTENING: sk_show(0, 40, 0, 12); break;
    case AE_LED_PLAYING:   sk_show(40, 20, 0, 12); break;
    case AE_LED_ERROR:     sk_show(60, 0, 0, 16); break;
  }
}
