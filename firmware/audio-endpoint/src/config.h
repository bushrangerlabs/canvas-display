#ifndef AE_CONFIG_H
#define AE_CONFIG_H

/*
 * Hardware pin map (matches the wiring in the project notes).
 *
 *   Sipeed mic array (I2S)          Pico W
 *     MIC_D0 ........................ GPIO 0
 *     MIC_D1 ........................ GPIO 1
 *     MIC_D2 ........................ GPIO 2
 *     MIC_D3 ........................ GPIO 3
 *     MIC_WS ........................ GPIO 4
 *     MIC_CK ........................ GPIO 5
 *     LED_CK ........................ GPIO 10
 *     LED_DA ........................ GPIO 11
 *
 *   UDA1334A DAC (I2S)              Pico W
 *     BCLK .......................... GPIO 6
 *     WSEL/LRCK ..................... GPIO 7
 *     DIN ........................... GPIO 8
 *
 * The four mic data lines are consecutive (0..3) so the PIO can read them as a
 * group with a single `in pins, 4`.
 */

#define AE_PIN_MIC_D0 0
#define AE_PIN_MIC_D1 1
#define AE_PIN_MIC_D2 2
#define AE_PIN_MIC_D3 3
#define AE_PIN_MIC_WS 4
#define AE_PIN_MIC_CK 5

#define AE_PIN_DAC_BCLK 6
#define AE_PIN_DAC_LRCK 7
#define AE_PIN_DAC_DIN 8

#define AE_PIN_LED_CK 10
#define AE_PIN_LED_DA 11

/*
 * Mic array clocking.
 *
 * The Sipeed wiki drives MIC_CK/MIC_WS from the host (the array is an I2S
 * slave). Some carrier boards add an onboard oscillator and drive them
 * themselves. Set AE_MIC_I2S_MASTER to 1 if the Pico must generate MIC_CK/WS,
 * or 0 if the array drives them and the Pico only samples.
 *
 * Milestone 0 (loopback) is the empirical check: if you get silence with one
 * setting, try the other.
 */
#ifndef AE_MIC_I2S_MASTER
#define AE_MIC_I2S_MASTER 1
#endif

/*
 * I2S bit depth per channel slot. The MSM261S4030H0 mics output 24-bit data in
 * a 32-bit slot; we read 32-bit slots and truncate to 16-bit PCM for transport.
 */
#define AE_I2S_SLOT_BITS 32

/* PIO/DMA buffering. */
#define AE_MIC_RING_FRAMES 8   /* 8 x 20 ms = 160 ms of capture headroom */
#define AE_PLAY_RING_FRAMES 16 /* 16 x 20 ms = 320 ms of playback headroom */

/*
 * Non-secret defaults only. Supply Wi-Fi credentials and enrollment secrets
 * through local CMake cache values; never store deployment credentials here.
 */
#ifndef AE_WIFI_SSID
#define AE_WIFI_SSID ""
#endif
#ifndef AE_WIFI_PASSWORD
#define AE_WIFI_PASSWORD ""
#endif
#ifndef AE_CORE_URL
#define AE_CORE_URL "http://core.local"
#endif
#ifndef AE_ENROLLMENT_SECRET
#define AE_ENROLLMENT_SECRET ""
#endif

/* mDNS hostname prefix; the full name is "<prefix>-<short-id>.local". */
#define AE_MDNS_PREFIX "canvas-audio"

#endif /* AE_CONFIG_H */
