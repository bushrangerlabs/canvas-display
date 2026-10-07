#ifndef AE_LED_H
#define AE_LED_H

#include <stdint.h>

typedef enum {
  AE_LED_BOOT = 0,
  AE_LED_WIFI,
  AE_LED_IDLE,
  AE_LED_LISTENING,
  AE_LED_PLAYING,
  AE_LED_ERROR,
} ae_led_state_t;

void led_init(void);
void led_set(ae_led_state_t state);
void led_poll(void);

#endif /* AE_LED_H */
