#ifndef AE_ENDPOINT_H
#define AE_ENDPOINT_H

#include <stdbool.h>

/* Register with Core and adopt the per-endpoint token it issues. Best-effort:
 * on failure the endpoint keeps using the enrollment secret. */
void ae_endpoint_register(void);

/* Retry registration periodically if it has not yet succeeded. */
void ae_endpoint_poll(void);

#endif /* AE_ENDPOINT_H */
