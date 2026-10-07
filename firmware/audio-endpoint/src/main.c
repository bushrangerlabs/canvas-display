#include "pico/stdlib.h"
#include "pico/cyw43_arch.h"
#include "hardware/watchdog.h"

#include <stdio.h>

#include "audio.h"
#include "net.h"
#include "wifi.h"
#include "led.h"
#include "endpoint.h"
#include "config.h"

int main(void) {
  stdio_init_all();
  sleep_ms(2000); /* let USB CDC enumerate so early logs are not lost */
  printf("\n[ae] boot — Canvas audio endpoint\n");
  printf("[ae] wifi ssid=%s core=%s\n", AE_WIFI_SSID, AE_CORE_URL);

  led_init();
  led_set(AE_LED_BOOT);

  printf("[ae] connecting wifi...\n");
  if (!ae_wifi_connect()) {
    printf("[ae] wifi FAILED\n");
    led_set(AE_LED_ERROR);
    while (true) { led_poll(); sleep_ms(100); }
  }
  printf("[ae] wifi connected\n");
  led_set(AE_LED_WIFI);

  printf("[ae] audio init...\n");
  if (!ae_audio_init()) {
    printf("[ae] audio init FAILED\n");
    led_set(AE_LED_ERROR);
    while (true) { led_poll(); sleep_ms(100); }
  }
  printf("[ae] audio ok\n");

  printf("[ae] net init...\n");
  cyw43_arch_lwip_begin();
  bool net_ok = ae_net_init();
  cyw43_arch_lwip_end();
  if (!net_ok) {
    printf("[ae] net init FAILED\n");
    led_set(AE_LED_ERROR);
    while (true) { led_poll(); sleep_ms(100); }
  }
  printf("[ae] net ok — listening on port %u\n", (unsigned)AE_DEFAULT_PORT);

  printf("[ae] registering with Core...\n");
  cyw43_arch_lwip_begin();
  ae_endpoint_register();
  cyw43_arch_lwip_end();
  led_set(AE_LED_IDLE);

  /* Hardware watchdog: if the main loop ever wedges (e.g. the CYW43 WiFi
   * driver stalls), reboot after 5 s instead of hanging forever. The board
   * reconnects WiFi + Core automatically on boot. */
  watchdog_enable(5000, true);

  uint32_t last_report = 0;
  while (true) {
    watchdog_update();
    cyw43_arch_poll();
    /* Keep session checks and raw TCP operations atomic against background
     * lwIP callbacks, including registration and heartbeat requests. */
    cyw43_arch_lwip_begin();
    ae_net_poll();
    ae_audio_fill_silence();
    ae_endpoint_poll();
    bool play_connected = ae_net_playback_connected();
    bool mic_connected = ae_net_mic_connected();
    enum ae_voice_state voice_state = ae_net_voice_state();
    cyw43_arch_lwip_end();
    switch (voice_state) {
      case AE_VOICE_READY:      led_set(AE_LED_IDLE); break;
      case AE_VOICE_LISTENING:  led_set(AE_LED_LISTENING); break;
      case AE_VOICE_PROCESSING: led_set(AE_LED_PLAYING); break;
      case AE_VOICE_ERROR:      led_set(AE_LED_ERROR); break;
    }
    led_poll();

    uint32_t now = to_ms_since_boot(get_absolute_time());
    if (now - last_report > 5000u) {
      last_report = now;
      printf("[ae] status mic=%d play=%d raw=%lu frames=%lu ck=%d ws=%d pws=%lu pdma=%lu\n", mic_connected, play_connected, (unsigned long)ae_audio_raw_words(), (unsigned long)ae_audio_frames_produced(), gpio_get(AE_PIN_MIC_CK), gpio_get(AE_PIN_MIC_WS), (unsigned long)ae_audio_play_samples_written(), (unsigned long)ae_audio_play_dma_words());
    }
    sleep_ms(1);
  }
}
