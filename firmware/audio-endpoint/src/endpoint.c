#include "endpoint.h"
#include "config.h"
#include "protocol.h"
#include "net.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#include "pico/stdlib.h"
#include "pico/unique_id.h"
#include "lwip/tcp.h"
#include "lwip/ip_addr.h"
#include "lwip/dns.h"

/* Minimal HTTP/1.0 POST client for Core registration + heartbeat.
 * Registration replies with JSON containing "token":"<value>"; we adopt it as
 * the endpoint token. The heartbeat keeps last_seen fresh so Core shows the
 * endpoint as online. */

#define AE_HEARTBEAT_MS 15000u

static bool s_registered;
static uint32_t s_last_attempt_ms;
static char s_id[32];

static void endpoint_id(char *out, size_t n) {
  pico_unique_board_id_t bid;
  pico_get_unique_board_id(&bid);
  snprintf(out, n, "ae-%02x%02x%02x%02x%02x%02x",
           bid.id[2], bid.id[3], bid.id[4], bid.id[5], bid.id[6], bid.id[7]);
}

/* --- tiny HTTP client state --- */
typedef enum { REQ_NONE, REQ_REGISTER, REQ_HEARTBEAT } req_kind_t;

static struct tcp_pcb *s_pcb;
static req_kind_t s_req_kind;
static char s_req[512];
static char s_resp[1024];
static uint32_t s_resp_len;
static ip_addr_t s_core_ip;
static bool s_dns_done, s_dns_ok;

static void http_close(void) {
  if (s_pcb) {
    tcp_arg(s_pcb, NULL);
    tcp_recv(s_pcb, NULL);
    tcp_err(s_pcb, NULL);
    tcp_close(s_pcb);
    s_pcb = NULL;
  }
  s_req_kind = REQ_NONE;
}

static void adopt_token_from_response(void) {
  const char *key = "\"token\"";
  char *p = strstr(s_resp, key);
  if (!p) return;
  p = strchr(p, ':');
  if (!p) return;
  p++;
  while (*p == ' ' || *p == '"') p++;
  char tok[96];
  size_t i = 0;
  while (*p && *p != '"' && i < sizeof(tok) - 1) tok[i++] = *p++;
  tok[i] = '\0';
  if (i > 0) {
    ae_net_set_token(tok);
    s_registered = true;
  }
}

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
  (void)arg;
  if (!p) { http_close(); return ERR_OK; }
  if (err != ERR_OK) { pbuf_free(p); return err; }
  tcp_recved(pcb, p->tot_len);
  struct pbuf *q = p;
  while (q && s_resp_len < sizeof(s_resp) - 1) {
    uint32_t space = sizeof(s_resp) - 1 - s_resp_len;
    uint32_t take = q->len < space ? q->len : space;
    memcpy(s_resp + s_resp_len, q->payload, take);
    s_resp_len += take;
    q = q->next;
  }
  s_resp[s_resp_len] = '\0';
  pbuf_free(p);
  if (s_req_kind == REQ_REGISTER) adopt_token_from_response();
  http_close();
  return ERR_OK;
}

static void on_err(void *arg, err_t err) {
  (void)arg; (void)err;
  s_pcb = NULL;
  s_req_kind = REQ_NONE;
}

static err_t on_connected(void *arg, struct tcp_pcb *pcb, err_t err) {
  (void)arg;
  if (err != ERR_OK) { http_close(); return err; }
  tcp_write(pcb, s_req, strlen(s_req), TCP_WRITE_FLAG_COPY);
  tcp_output(pcb);
  return ERR_OK;
}

static void on_dns(const char *name, const ip_addr_t *ip, void *arg) {
  (void)name; (void)arg;
  if (ip) { s_core_ip = *ip; s_dns_ok = true; }
  s_dns_done = true;
}

/* Build the request and kick off the connection. Returns false if the request
 * cannot be started (DNS pending or connect failed). */
static bool start_request(req_kind_t kind) {
  /* Parse host:port from AE_CORE_URL (http://host:port). */
  const char *u = AE_CORE_URL;
  const char *host = strstr(u, "://");
  host = host ? host + 3 : u;
  char hostname[64];
  size_t i = 0;
  while (host[i] && host[i] != ':' && host[i] != '/' && i < sizeof(hostname) - 1) { hostname[i] = host[i]; i++; }
  hostname[i] = '\0';
  uint16_t port = 80;
  const char *colon = strchr(host, ':');
  if (colon) port = (uint16_t)atoi(colon + 1);

  if (kind == REQ_REGISTER) {
    char body[256];
    int blen = snprintf(body, sizeof(body),
      "{\"id\":\"%s\",\"name\":\"%s\",\"port\":%u,\"firmware\":\"%u\"}",
      s_id, s_id, (unsigned)AE_DEFAULT_PORT, (unsigned)AE_PROTOCOL_VERSION);
    snprintf(s_req, sizeof(s_req),
      "POST /api/edge/audio-endpoints/register HTTP/1.0\r\n"
      "Host: %s\r\n"
      "Content-Type: application/json\r\n"
      "X-Enrollment-Secret: %s\r\n"
      "Content-Length: %d\r\n"
      "Connection: close\r\n\r\n%s",
      hostname, AE_ENROLLMENT_SECRET, blen, body);
  } else { /* REQ_HEARTBEAT */
    char body[64];
    int blen = snprintf(body, sizeof(body), "{\"id\":\"%s\"}", s_id);
    snprintf(s_req, sizeof(s_req),
      "POST /api/edge/audio-endpoints/heartbeat HTTP/1.0\r\n"
      "Host: %s\r\n"
      "Content-Type: application/json\r\n"
      "Authorization: Bearer %s\r\n"
      "Content-Length: %d\r\n"
      "Connection: close\r\n\r\n%s",
      hostname, ae_net_token(), blen, body);
  }

  s_resp_len = 0;
  s_dns_done = false;
  s_dns_ok = false;

  ip_addr_t ip;
  if (ipaddr_aton(hostname, &ip)) {
    s_core_ip = ip; s_dns_ok = true; s_dns_done = true;
  } else {
    err_t e = dns_gethostbyname(hostname, &ip, on_dns, NULL);
    if (e == ERR_OK) { s_core_ip = ip; s_dns_ok = true; s_dns_done = true; }
    else if (e != ERR_INPROGRESS) return false;
  }

  /* DNS may complete asynchronously; the poll loop retries. */
  if (!s_dns_done || !s_dns_ok) return false;

  s_pcb = tcp_new_ip_type(IPADDR_TYPE_ANY);
  if (!s_pcb) return false;
  s_req_kind = kind;
  tcp_arg(s_pcb, NULL);
  tcp_recv(s_pcb, on_recv);
  tcp_err(s_pcb, on_err);
  if (tcp_connect(s_pcb, &s_core_ip, port, on_connected) != ERR_OK) {
    http_close();
    return false;
  }
  return true;
}

void ae_endpoint_register(void) {
  if (!s_id[0]) endpoint_id(s_id, sizeof(s_id));
  s_last_attempt_ms = to_ms_since_boot(get_absolute_time());
  start_request(REQ_REGISTER);
}

void ae_endpoint_poll(void) {
  uint32_t now = to_ms_since_boot(get_absolute_time());
  if (s_pcb) return; /* request in flight */

  if (!s_registered) {
    if (now - s_last_attempt_ms < 30000u) return;
    ae_endpoint_register();
    return;
  }

  /* Registered: heartbeat to keep last_seen fresh (online status in Core). */
  if (now - s_last_attempt_ms >= AE_HEARTBEAT_MS) {
    s_last_attempt_ms = now;
    start_request(REQ_HEARTBEAT);
  }
}