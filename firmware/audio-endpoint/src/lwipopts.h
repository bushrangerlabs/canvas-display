#ifndef _LWIPOPTS_H
#define _LWIPOPTS_H

/* lwIP configuration for pico_cyw43_arch_lwip_threadsafe_background.
 * Based on the standard Pico W example configuration. */

#define NO_SYS                      1
/* DIAGNOSIS MODE: assertions enabled (LWIP_NOASSERT must NOT be defined at
 * all — lwIP checks #ifndef). We want to see whether our connection lifecycle
 * contributes to the "tcp_receive: valid queue length" assertion. The 5 s
 * hardware watchdog reboots the board if it fires. */
#define LWIP_SOCKET                 0
#define LWIP_NETCONN                0
#define MEM_LIBC_MALLOC             0
#define MEM_ALIGNMENT               4
#define MEM_SIZE                    16000
#define MEMP_NUM_TCP_SEG            64
#define MEMP_NUM_ARP_QUEUE          10
#define PBUF_POOL_SIZE              48
#define LWIP_ARP                    1
#define LWIP_ETHERNET               1
#define LWIP_ICMP                   1
#define LWIP_RAW                    1
#define TCP_WND                     (8 * TCP_MSS)
#define TCP_MSS                     1460
#define TCP_SND_BUF                 (8 * TCP_MSS)
#define TCP_SND_QUEUELEN            ((4 * (TCP_SND_BUF) + (TCP_MSS - 1)) / (TCP_MSS))
/* Disable the oversize write-coalescing optimisation: it has caused
 * snd_queuelen accounting mismatches ("tcp_receive: valid queue length"
 * assertion) when a client closes while streaming data is in flight.
 * LWIP_NETIF_TX_SINGLE_PBUF depends on oversize, so it goes too. */
#define TCP_OVERSIZE                0
#define LWIP_NETIF_TX_SINGLE_PBUF   0
#define LWIP_NETIF_STATUS_CALLBACK  1
#define LWIP_NETIF_LINK_CALLBACK    1
#define LWIP_NETIF_HOSTNAME         1
#define MEM_STATS                   0
#define SYS_STATS                   0
#define MEMP_STATS                  0
#define LINK_STATS                  0
#define LWIP_CHKSUM_ALGORITHM       3
#define LWIP_DHCP                   1
#define LWIP_IPV4                   1
#define LWIP_TCP                    1
#define LWIP_UDP                    1
#define LWIP_DNS                    1
#define LWIP_TCP_KEEPALIVE          1
#define DHCP_DOES_ARP_CHECK         0
#define LWIP_DHCP_DOES_ACD_CHECK    0
#define LWIP_STATS                  0
#define LWIP_STATS_DISPLAY          0
#define MEMP_NUM_TCP_PCB            16
#define MEMP_NUM_TCP_PCB_LISTEN     8
#define TCP_QUEUE_OOSEQ             1
#define LWIP_TCP_SACK_OUT           1
#define LWIP_TCP_MAX_SACK_NUM       4
#define LWIP_TCP_TIMESTAMPS         0
#define LWIP_WND_SCALE              1
#define TCP_RCV_SCALE               2
#define LWIP_TCP_RTO_TIME           1500
#define LWIP_ALTCP                  1
#define LWIP_ALTCP_TLS              0
#define LWIP_HTTPD                  0
#define LWIP_NUM_NETIF_CLIENT_DATA  1
#define LWIP_SO_RCVTIMEO            1
#define LWIP_SO_SNDTIMEO            1
#define LWIP_SO_RCVBUF              1
#define LWIP_SO_LINGER              0
#define LWIP_TCPIP_CORE_LOCKING     1
#define LWIP_TCPIP_CORE_LOCKING_INPUT 1
#define CHECKSUM_GEN_IP             1
#define CHECKSUM_GEN_UDP            1
#define CHECKSUM_GEN_TCP            1
#define CHECKSUM_CHECK_IP           1
#define CHECKSUM_CHECK_UDP          1
#define CHECKSUM_CHECK_TCP          1
#define CHECKSUM_GEN_ICMP           1
#define CHECKSUM_CHECK_ICMP         1
#define LWIP_FEATURES               1
#define LWIP_IPV6                   0
#define LWIP_IPV6_MLD               0
#define LWIP_IPV6_DHCP6             0
#define LWIP_IPV6_AUTOCONFIG        0
#define LWIP_IPV6_DUP_DETECT_ATTEMPTS 0
#define LWIP_IPV6_NUM_ADDRESSES     0
#define LWIP_IPV6_SEND_ROUTER_SOLICIT 0
#define LWIP_IPV6_ADDRESS_LIFETIMES 0
#define LWIP_IPV6_DHCP6_STATELESS   0
#define LWIP_IPV6_DHCP6_STATEFUL    0
#define LWIP_IPV6_ND                0
#define LWIP_IPV6_SCOPES            0
#define LWIP_IPV6_SCOPES_DEBUG      0
#define LWIP_IPV6_FRAG              0
#define LWIP_IPV6_REASS             0
#define LWIP_IPV6_ROUTE             0

#endif /* _LWIPOPTS_H */
