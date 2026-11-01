#pragma once

namespace net {

void captive_dns_start();
void captive_dns_stop();
/** First time online: SNTP and mDNS. */
void internal_on_online();

}  // namespace net
