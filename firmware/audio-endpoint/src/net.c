#include "net.h"
#include "protocol.h"
#include "config.h"
#include "audio.h"

#include <string.h>
#include <stdio.h>

#include "pico/stdlib.h"
#include "lwip/tcp.h"
#include "lwip/ip_addr.h"

/* Enable full ACK/wait tracing only for targeted transport diagnosis. */
#ifndef AE_TCP_VERBOSE_DIAGNOSTICS
#define AE_TCP_VERBOSE_DIAGNOSTICS 0
#endif

/* ------------------------------------------------------------------ */
/* Connection pool                                                     */
/* ------------------------------------------------------------------ */

typedef struct {
  struct tcp_pcb *pcb;
  uint32_t session;  /* monotonic session id — visible in every log line */
  int role;        /* -1 pending, AE_ROLE_MIC, AE_ROLE_PLAYBACK */
  bool authed;
  bool closing;    /* reserved until close succeeds or lwIP reports destruction */
  uint8_t rx[AE_MAX_FRAME_PAYLOAD + 3];
  uint32_t rx_len;
} ae_conn_t;

#define AE_MAX_CONNS 4
static ae_conn_t s_conns[AE_MAX_CONNS];
static ae_conn_t *s_mic_conn;
static ae_conn_t *s_play_conn;
static enum ae_voice_state s_voice_state = AE_VOICE_READY;
static struct tcp_pcb *s_listen;
static char s_token[96] = AE_ENROLLMENT_SECRET;
static uint32_t s_next_session = 1;

/* Debug: how many frames the pump had available but could not send, and why. */
static uint32_t s_pump_skip_no_data;
static uint32_t s_pump_skip_sndbuf;
static uint32_t s_pump_sent;
static uint32_t s_mic_lost_logged; /* avoid spamming when mic conn drops */

void ae_net_set_token(const char *token) {
  if (!token) return;
  strncpy(s_token, token, sizeof(s_token) - 1);
  s_token[sizeof(s_token) - 1] = '\0';
}

const char *ae_net_token(void) { return s_token; }

bool ae_net_mic_connected(void) { return s_mic_conn && s_mic_conn->authed; }
bool ae_net_playback_connected(void) { return s_play_conn && s_play_conn->authed; }

enum ae_voice_state ae_net_voice_state(void) {
  return s_mic_conn && s_mic_conn->authed && !s_mic_conn->closing &&
         s_mic_conn->role == AE_ROLE_MIC ? s_voice_state : AE_VOICE_READY;
}

static void conn_reset(ae_conn_t *c) {
  c->pcb = NULL;
  c->role = -1;
  c->authed = false;
  c->closing = false;
  c->rx_len = 0;
}

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err);
static err_t on_sent(void *arg, struct tcp_pcb *pcb, u16_t len);
static void on_err(void *arg, err_t err);
static err_t on_close_poll(void *arg, struct tcp_pcb *pcb);

static unsigned occupied_slots(void) {
  unsigned count = 0;
  for (unsigned i = 0; i < AE_MAX_CONNS; i++) count += s_conns[i].pcb != NULL;
  return count;
}

/* Called only while the lwIP lock is held (including callback context). */
static void conn_try_close(ae_conn_t *c) {
  struct tcp_pcb *pcb = c->pcb;
  /* ERR_OK can transfer ownership immediately, or leave queued audio/FIN for
   * lwIP to drain. Detach ALL callbacks before that transfer, never afterwards. */
  tcp_arg(pcb, NULL);
  tcp_recv(pcb, NULL);
  tcp_sent(pcb, NULL);
  tcp_err(pcb, NULL);
  tcp_poll(pcb, NULL, 0);
  err_t err = tcp_close(pcb);
  printf("[ae] tcp_close session=%u err=%d\n", c->session, (int)err);
  if (err == ERR_OK) {
    /* pcb must not be accessed after successful close. */
    uint32_t session = c->session;
    conn_reset(c);
    printf("[ae] CLOSE RELEASE session=%u slots=%u\n", session, occupied_slots());
    return;
  }
  /* A failed close leaves the PCB application-owned. Keep this pool slot and
   * restore callbacks so ACKs/errors remain associated with this session.
   * Poll retries at lwIP's slow-timer cadence, not every main-loop iteration. */
  tcp_arg(pcb, c);
  tcp_recv(pcb, on_recv);
  tcp_sent(pcb, on_sent);
  tcp_err(pcb, on_err);
  tcp_poll(pcb, on_close_poll, 2);
}

static void conn_close(ae_conn_t *c) {
  if (!c || !c->pcb || c->closing) return;
  printf("[ae] CLOSE REQUEST session=%u pcb=%p sndbuf=%u qlen=%u slots=%u\n",
         c->session, (void *)c->pcb, (unsigned)tcp_sndbuf(c->pcb),
         (unsigned)tcp_sndqueuelen(c->pcb), occupied_slots());
  c->closing = true;
  c->authed = false;
  if (s_mic_conn == c) {
    s_mic_conn = NULL;
    s_voice_state = AE_VOICE_READY;
  }
  if (s_play_conn == c) s_play_conn = NULL;
  conn_try_close(c);
}

static err_t on_close_poll(void *arg, struct tcp_pcb *pcb) {
  ae_conn_t *c = (ae_conn_t *)arg;
  LWIP_ASSERT("close poll owns session", c && c->pcb == pcb && c->closing);
  printf("[ae] CLOSE RETRY session=%u pcb=%p\n", c->session, (void *)pcb);
  conn_try_close(c);
  return ERR_OK;
}

/* ------------------------------------------------------------------ */
/* Framing helpers                                                     */
/* ------------------------------------------------------------------ */

static void send_msg(ae_conn_t *c, uint8_t type, const void *payload, uint16_t len) {
  if (!c || !c->pcb || c->closing) return;
  uint16_t total = (uint16_t)(len + 1u);
  uint8_t buf[3 + 256];
  uint16_t n = len > 256 ? 256 : len;
  buf[0] = (uint8_t)(total & 0xff);
  buf[1] = (uint8_t)(total >> 8);
  buf[2] = type;
  if (n) memcpy(buf + 3, payload, n);
  tcp_write(c->pcb, buf, 3u + n, TCP_WRITE_FLAG_COPY);
  tcp_output(c->pcb);
}

static void send_hello_ack(ae_conn_t *c, uint8_t status) {
  uint8_t p[2] = { AE_PROTOCOL_VERSION, status };
  send_msg(c, AE_MSG_HELLO_ACK, p, sizeof(p));
}

/* ------------------------------------------------------------------ */
/* Callbacks                                                           */
/* ------------------------------------------------------------------ */

static void on_err(void *arg, err_t err) {
  ae_conn_t *c = (ae_conn_t *)arg;
  if (!c) return;
  printf("[ae] ERR session=%u pcb=%p err=%d wasMic=%d wasPlay=%d\n",
         c->session, c->pcb ? (void *)c->pcb : 0, (int)err, s_mic_conn == c, s_play_conn == c);
  if (s_mic_conn == c) {
    s_mic_conn = NULL;
    s_voice_state = AE_VOICE_READY;
  }
  if (s_play_conn == c) s_play_conn = NULL;
  uint32_t session = c->session;
  conn_reset(c);
  printf("[ae] ERROR RELEASE session=%u slots=%u\n", session, occupied_slots());
}

static void handle_message(ae_conn_t *c, uint8_t type, const uint8_t *p, uint16_t len) {
  switch (type) {
    case AE_MSG_HELLO: {
      if (len < 2) { send_hello_ack(c, 1); return; }
      uint8_t role = p[0];
      uint8_t tlen = p[1];
      if (2u + tlen > len) { send_hello_ack(c, 1); return; }
      printf("[ae] RX HELLO session=%u role=%u\n", c->session, role);
      bool ok = (tlen == strlen(s_token)) && (memcmp(p + 2, s_token, tlen) == 0);
      if (!ok) { printf("[ae] AUTH FAIL session=%u\n", c->session); send_hello_ack(c, 1); return; }
      if (role == AE_ROLE_MIC) {
        if (s_mic_conn && s_mic_conn != c) {
          printf("[ae] REPLACE mic session=%u -> session=%u\n", s_mic_conn->session, c->session);
          conn_close(s_mic_conn);
        }
        if (s_mic_conn != c) s_voice_state = AE_VOICE_READY;
        s_mic_conn = c;
        printf("[ae] MIC ENABLE session=%u pcb=%p\n", c->session, (void *)c->pcb);
      } else if (role == AE_ROLE_PLAYBACK) {
        if (s_play_conn && s_play_conn != c) {
          printf("[ae] REPLACE play session=%u -> session=%u\n", s_play_conn->session, c->session);
          conn_close(s_play_conn);
        }
        s_play_conn = c;
        /* A MIC owner re-authenticating as playback loses LED authority. */
        if (s_mic_conn == c) s_voice_state = AE_VOICE_READY;
      } else {
        send_hello_ack(c, 1); return;
      }
      c->role = role;
      c->authed = true;
      printf("[ae] AUTH OK session=%u role=%u\n", c->session, role);
      send_hello_ack(c, 0);
      break;
    }
    case AE_MSG_VOICE_STATE:
      if (c == s_mic_conn && c->authed && !c->closing &&
          c->role == AE_ROLE_MIC && len == 1 && p[0] <= AE_VOICE_ERROR) {
        s_voice_state = (enum ae_voice_state)p[0];
      }
      break;
    case AE_MSG_CONFIG:
      if (len >= 6) {
        uint32_t rate = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
        ae_audio_set_play_rate(rate);
      }
      break;
    case AE_MSG_AUDIO:
      if (c->role == AE_ROLE_PLAYBACK) ae_audio_write_play(p, len);
      break;
    case AE_MSG_PING:
      send_msg(c, AE_MSG_PONG, NULL, 0);
      break;
    default:
      break;
  }
}

/* Log when the peer ACKs our sent data (helps correlate queue drain vs close). */
static err_t on_sent(void *arg, struct tcp_pcb *pcb, u16_t len) {
  ae_conn_t *c = (ae_conn_t *)arg;
  if (!c) return ERR_OK;
  LWIP_ASSERT("sent callback owns session", c->pcb == pcb);
#if AE_TCP_VERBOSE_DIAGNOSTICS
  printf("[ae] tcp_sent session=%u len=%u sndbuf=%d qlen=%u\n",
         c->session, len, (int)tcp_sndbuf(pcb), (unsigned)tcp_sndqueuelen(pcb));
#else
  (void)len;
#endif
  return ERR_OK;
}

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
  ae_conn_t *c = (ae_conn_t *)arg;
  LWIP_ASSERT("recv callback owns session", c && c->pcb == pcb);
  if (!p) {
    printf("[ae] RX FIN session=%u pcb=%p\n", c ? c->session : 0, (void *)pcb);
    conn_close(c);
    return ERR_OK;
  }
  if (err != ERR_OK) { pbuf_free(p); return err; }
  if (c->closing) {
    tcp_recved(pcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
  }

  tcp_recved(pcb, p->tot_len);

  struct pbuf *q = p;
  while (q) {
    uint32_t space = sizeof(c->rx) - c->rx_len;
    uint32_t take = q->len < space ? q->len : space;
    memcpy(c->rx + c->rx_len, q->payload, take);
    c->rx_len += take;
    q = q->next;
  }
  pbuf_free(p);

  uint32_t off = 0;
  while (c->rx_len - off >= 3u) {
    uint16_t mlen = (uint16_t)c->rx[off] | ((uint16_t)c->rx[off + 1] << 8);
    if (mlen < 1u) { off += 3u; continue; }
    if (c->rx_len - off < (uint32_t)(2u + mlen)) break;
    handle_message(c, c->rx[off + 2], c->rx + off + 3, (uint16_t)(mlen - 1u));
    off += 2u + mlen;
  }
  if (off) {
    memmove(c->rx, c->rx + off, c->rx_len - off);
    c->rx_len -= off;
  }
  return ERR_OK;
}

static err_t on_accept(void *arg, struct tcp_pcb *newpcb, err_t err) {
  (void)arg;
  if (err != ERR_OK || !newpcb) return ERR_VAL;

  ae_conn_t *c = NULL;
  for (int i = 0; i < AE_MAX_CONNS; i++) {
    if (!s_conns[i].pcb) { c = &s_conns[i]; break; }
  }
  if (!c) {
    printf("[ae] ABORT reason=no-context pcb=%p slots=%u\n", (void *)newpcb, occupied_slots());
    tcp_abort(newpcb);
    return ERR_ABRT;
  }

  conn_reset(c);
  c->session = s_next_session++;
  c->pcb = newpcb;
  printf("[ae] ACCEPT session=%u pcb=%p\n", c->session, (void *)newpcb);
  tcp_setprio(newpcb, TCP_PRIO_MIN);
  tcp_arg(newpcb, c);
  tcp_recv(newpcb, on_recv);
  tcp_sent(newpcb, on_sent);
  tcp_err(newpcb, on_err);
  return ERR_OK;
}

/* ------------------------------------------------------------------ */
/* Init + poll                                                         */
/* ------------------------------------------------------------------ */

bool ae_net_init(void) {
  s_listen = tcp_new_ip_type(IPADDR_TYPE_ANY);
  if (!s_listen) return false;
  if (tcp_bind(s_listen, IP_ANY_TYPE, AE_DEFAULT_PORT) != ERR_OK) return false;
  s_listen = tcp_listen(s_listen);
  if (!s_listen) return false;
  tcp_accept(s_listen, on_accept);
  return true;
}

void ae_net_poll(void) {
  if (!s_mic_conn || !s_mic_conn->authed || !s_mic_conn->pcb) {
    /* Mic connection lost — log once per loss so we can see WHEN the pump
     * stops relative to the session lifecycle. */
    if (s_mic_conn && !s_mic_conn->authed && !s_mic_lost_logged) {
      printf("[ae] PUMP STOP session=%u reason=not-authed\n", s_mic_conn->session);
      s_mic_lost_logged = 1;
    }
    return;
  }
  s_mic_lost_logged = 0;

  /* One contiguous buffer per frame: [u16 len][u8 type][u32 seq][u32 ts][PCM].
   * Queue corruption was fixed by raw-API synchronization, not framing. */
  static uint8_t frame[3 + 8 + AE_MIC_FRAME_BYTES];
  static uint32_t seq;
  if (ae_audio_read_mic(frame + 3 + 8, AE_MIC_FRAME_BYTES) != AE_MIC_FRAME_BYTES) {
    /* Pump has no frame ready — log the raw/consumed state occasionally so we
     * can see whether capture is keeping up. */
    s_pump_skip_no_data++;
    if (AE_TCP_VERBOSE_DIAGNOSTICS && (s_pump_skip_no_data % 250u) == 1u) {
      printf("[ae] PUMP WAIT session=%u raw=%lu consumed=%lu\n",
             s_mic_conn->session,
             (unsigned long)ae_audio_raw_words(),
             (unsigned long)ae_audio_frames_produced());
    }
    return;
  }

  static uint32_t sent;
  if (AE_TCP_VERBOSE_DIAGNOSTICS && (sent < 3 || (sent % 100u) == 0u)) printf("[ae] sending mic frame %lu\n", (unsigned long)sent);
  sent++;

  uint16_t payload = (uint16_t)(1u + 8u + AE_MIC_FRAME_BYTES);
  frame[0] = (uint8_t)(payload & 0xff);
  frame[1] = (uint8_t)(payload >> 8);
  frame[2] = AE_MSG_AUDIO;
  uint32_t ts = to_ms_since_boot(get_absolute_time());
  frame[3] = (uint8_t)seq; frame[4] = (uint8_t)(seq >> 8); frame[5] = (uint8_t)(seq >> 16); frame[6] = (uint8_t)(seq >> 24);
  frame[7] = (uint8_t)ts;  frame[8] = (uint8_t)(ts >> 8);  frame[9] = (uint8_t)(ts >> 16);  frame[10] = (uint8_t)(ts >> 24);
  seq++;

  if (tcp_sndbuf(s_mic_conn->pcb) < (uint16_t)sizeof(frame)) {
    s_pump_skip_sndbuf++;
    if ((s_pump_skip_sndbuf % 250u) == 1u) {
      printf("[ae] PUMP SKIP session=%u pcb=%p reason=sndbuf sndbuf=%d qlen=%u\n",
             s_mic_conn->session, (void *)s_mic_conn->pcb,
             (int)tcp_sndbuf(s_mic_conn->pcb), (unsigned)tcp_sndqueuelen(s_mic_conn->pcb));
    }
    return;
  }
  err_t e = tcp_write(s_mic_conn->pcb, frame, sizeof(frame), TCP_WRITE_FLAG_COPY);
  s_pump_sent++;
  if (e != ERR_OK || s_pump_sent < 3 || (s_pump_sent % 500u) == 0u) {
    printf("[ae] PUMP SEND session=%u len=%u err=%d sndbuf=%d qlen=%u\n",
           s_mic_conn->session, (unsigned)sizeof(frame), (int)e,
           (int)tcp_sndbuf(s_mic_conn->pcb), (unsigned)tcp_sndqueuelen(s_mic_conn->pcb));
  }
  tcp_output(s_mic_conn->pcb);
}
