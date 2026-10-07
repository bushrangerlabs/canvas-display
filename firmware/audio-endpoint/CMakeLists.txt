cmake_minimum_required(VERSION 3.13)

# Pull in the Pico SDK. Set PICO_SDK_PATH, or place the SDK at ../pico-sdk.
include(pico_sdk_import.cmake)

project(canvas_audio_endpoint C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

# Supply deployment credentials through local CMake cache entries; never store
# Wi-Fi credentials or enrollment secrets in source control.
set(AE_WIFI_SSID "" CACHE STRING "Local Wi-Fi SSID")
set(AE_WIFI_PASSWORD "" CACHE STRING "Local Wi-Fi password")
set(AE_CORE_URL "http://core.local" CACHE STRING "Local Core URL")
set(AE_ENROLLMENT_SECRET "" CACHE STRING "Local enrollment secret")

add_executable(canvas_audio_endpoint
  src/main.c
  src/audio.c
  src/net.c
  src/wifi.c
  src/led.c
  src/endpoint.c
)

target_include_directories(canvas_audio_endpoint PRIVATE src)
target_compile_definitions(canvas_audio_endpoint PRIVATE
  "AE_WIFI_SSID=\"${AE_WIFI_SSID}\""
  "AE_WIFI_PASSWORD=\"${AE_WIFI_PASSWORD}\""
  "AE_CORE_URL=\"${AE_CORE_URL}\""
  "AE_ENROLLMENT_SECRET=\"${AE_ENROLLMENT_SECRET}\""
)

# Generate the PIO headers from the .pio sources.
pico_generate_pio_header(canvas_audio_endpoint ${CMAKE_CURRENT_LIST_DIR}/src/i2s_output.pio)
pico_generate_pio_header(canvas_audio_endpoint ${CMAKE_CURRENT_LIST_DIR}/src/i2s_input.pio)

target_link_libraries(canvas_audio_endpoint
  pico_stdlib
  pico_cyw43_arch_lwip_threadsafe_background
  pico_lwip
  hardware_pio
  hardware_dma
  hardware_clocks
)

# USB stdio only: GPIO 0-8 are all used by I2S (mic data + DAC clocks).
pico_enable_stdio_usb(canvas_audio_endpoint 1)
pico_enable_stdio_uart(canvas_audio_endpoint 0)

pico_add_extra_outputs(canvas_audio_endpoint)

# Explicitly opt-in raw I2S diagnostic. It is a separate executable and never
# replaces or changes the production endpoint target.
option(AE_BUILD_RAW_I2S_DIAG "Build the temporary USB raw-I2S diagnostic firmware" OFF)
if(AE_BUILD_RAW_I2S_DIAG)
  add_executable(canvas_audio_raw_i2s_diag
    src/i2s_raw_diag.c
  )
  target_include_directories(canvas_audio_raw_i2s_diag PRIVATE src)
  target_compile_definitions(canvas_audio_raw_i2s_diag PRIVATE AE_RAW_I2S_DIAG=1)
  pico_generate_pio_header(canvas_audio_raw_i2s_diag ${CMAKE_CURRENT_LIST_DIR}/src/i2s_raw_diag.pio)
  target_link_libraries(canvas_audio_raw_i2s_diag
    pico_stdlib
    hardware_pio
    hardware_dma
    hardware_clocks
  )
  pico_enable_stdio_usb(canvas_audio_raw_i2s_diag 1)
  pico_enable_stdio_uart(canvas_audio_raw_i2s_diag 0)
  pico_add_extra_outputs(canvas_audio_raw_i2s_diag)
endif()
