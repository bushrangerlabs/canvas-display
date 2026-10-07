#include "wifi.h"
#include "config.h"

#include "pico/stdlib.h"
#include "pico/cyw43_arch.h"

bool ae_wifi_connect(void) {
  if (cyw43_arch_init()) return false;
  cyw43_arch_enable_sta_mode();
  /* Retry a few times; the AP may not be up yet at boot. */
  for (int attempt = 0; attempt < 5; attempt++) {
    if (cyw43_arch_wifi_connect_timeout_ms(AE_WIFI_SSID, AE_WIFI_PASSWORD,
                                           CYW43_AUTH_WPA2_AES_PSK, 15000) == 0) {
      return true;
    }
    sleep_ms(2000);
  }
  return false;
}

bool ae_wifi_connected(void) {
  int link = 0;
  cyw43_arch_lwip_begin();
  link = cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA);
  cyw43_arch_lwip_end();
  return link == CYW43_LINK_UP;
}
