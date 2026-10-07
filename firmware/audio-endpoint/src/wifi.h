#ifndef AE_WIFI_H
#define AE_WIFI_H

#include <stdbool.h>

/* Connect to the configured WiFi network. Blocks until connected or timeout. */
bool ae_wifi_connect(void);

/* True once associated with an IP. */
bool ae_wifi_connected(void);

#endif /* AE_WIFI_H */
