// Captive-portal DNS (03 §8): while in setup mode, answer every A query with 192.168.4.1 so
// phones open the setup wizard by themselves.
#include <cstring>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "net_internal.hpp"

static const char* TAG = "dns";

namespace net {

static volatile bool s_run = false;
static TaskHandle_t s_task = nullptr;

static void dns_task(void*) {
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "socket failed");
        s_task = nullptr;
        vTaskDelete(nullptr);
        return;
    }
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(53);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(sock, (sockaddr*)&addr, sizeof addr) < 0) {
        ESP_LOGE(TAG, "bind :53 failed");
        close(sock);
        s_task = nullptr;
        vTaskDelete(nullptr);
        return;
    }
    timeval tv{1, 0};
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    uint8_t buf[512];
    while (s_run) {
        sockaddr_in from{};
        socklen_t flen = sizeof from;
        int len = recvfrom(sock, buf, sizeof buf - 16, 0, (sockaddr*)&from, &flen);
        if (len < 12) continue;
        if (buf[2] & 0x80) continue;  // a response, not a query
        uint16_t qd = (uint16_t)((buf[4] << 8) | buf[5]);
        if (qd != 1) continue;
        // Walk the question name to find QTYPE
        int p = 12;
        while (p < len && buf[p] != 0) p += buf[p] + 1;
        if (p + 5 > len) continue;
        uint16_t qtype = (uint16_t)((buf[p + 1] << 8) | buf[p + 2]);
        int qend = p + 5;
        buf[2] = 0x81;  // response, recursion desired
        buf[3] = 0x80;  // recursion available, no error
        buf[6] = 0, buf[7] = 0;   // ANCOUNT
        buf[8] = 0, buf[9] = 0;   // NSCOUNT
        buf[10] = 0, buf[11] = 0; // ARCOUNT
        int out = qend;
        if (qtype == 1 || qtype == 255) {  // A or ANY
            buf[7] = 1;
            const uint8_t ans[16] = {0xC0, 0x0C, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3C,
                                     0x00, 0x04, 192,  168,  4,    1};
            std::memcpy(buf + out, ans, sizeof ans);
            out += sizeof ans;
        }
        sendto(sock, buf, out, 0, (sockaddr*)&from, flen);
    }
    close(sock);
    s_task = nullptr;
    vTaskDelete(nullptr);
}

void captive_dns_start() {
    if (s_run) return;
    s_run = true;
    xTaskCreate(dns_task, "dns", 3072, nullptr, 4, &s_task);
    ESP_LOGI(TAG, "captive DNS on :53");
}

void captive_dns_stop() { s_run = false; }

}  // namespace net
