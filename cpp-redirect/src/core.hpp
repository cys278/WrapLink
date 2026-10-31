// Dependency-free core of the WrapLink C++ redirect service.
//
// Everything here must stay byte-for-byte compatible with the Node.js
// service (src/cache/keys.ts and src/store/cached-link-store.ts): both
// services read and write the same Redis keys and hash fields.
#pragma once

#include <array>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace wraplink {

constexpr std::uint32_t kLinkKeyShards = 1024;

// 32-bit FNV-1a, identical to fnv1a32() in src/cache/keys.ts.
inline std::uint32_t fnv1a32(std::string_view value) {
  std::uint32_t hash = 0x811c9dc5u;
  for (unsigned char byte : value) {
    hash ^= byte;
    hash *= 0x01000193u;
  }
  return hash;
}

inline std::uint32_t shardOf(std::string_view code) {
  return fnv1a32(code) % kLinkKeyShards;
}

// wraplink:link:{0042}:code (the hash tag keeps a link and its sync queue
// in the same Redis Cluster slot).
inline std::string linkKey(std::string_view code) {
  const std::uint32_t shard = shardOf(code);
  std::string key = "wraplink:link:{";
  key.push_back(static_cast<char>('0' + (shard / 1000) % 10));
  key.push_back(static_cast<char>('0' + (shard / 100) % 10));
  key.push_back(static_cast<char>('0' + (shard / 10) % 10));
  key.push_back(static_cast<char>('0' + shard % 10));
  key.append("}:");
  key.append(code);
  return key;
}

// Same rule as CODE_PATTERN in src/app.ts: ^[A-Za-z0-9_-]{4,32}$
inline bool isValidCode(std::string_view code) {
  if (code.size() < 4 || code.size() > 32) return false;
  for (char c : code) {
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                    (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant).
inline std::int64_t daysFromCivil(std::int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const std::int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<std::int64_t>(doe) - 719468;
}

// Parses exactly what JavaScript's Date#toISOString() produces,
// YYYY-MM-DDTHH:MM:SS.sssZ, into epoch milliseconds.
inline std::optional<std::int64_t> parseIsoUtcMillis(std::string_view s) {
  if (s.size() != 24 || s[4] != '-' || s[7] != '-' || s[10] != 'T' ||
      s[13] != ':' || s[16] != ':' || s[19] != '.' || s[23] != 'Z') {
    return std::nullopt;
  }
  bool ok = true;
  auto num = [&](std::size_t pos, std::size_t len) {
    int value = 0;
    for (std::size_t i = pos; i < pos + len; ++i) {
      if (s[i] < '0' || s[i] > '9') ok = false;
      value = value * 10 + (s[i] - '0');
    }
    return value;
  };
  const int year = num(0, 4), month = num(5, 2), day = num(8, 2);
  const int hour = num(11, 2), minute = num(14, 2), second = num(17, 2);
  const int millis = num(20, 3);
  if (!ok || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 ||
      minute > 59 || second > 60) {
    return std::nullopt;
  }
  const std::int64_t days = daysFromCivil(year, static_cast<unsigned>(month),
                                          static_cast<unsigned>(day));
  return ((days * 24 + hour) * 60 + minute) * 60000 +
         static_cast<std::int64_t>(second) * 1000 + millis;
}

// PostgreSQL array literal for codes already checked by isValidCode().
inline std::string pgTextArray(const std::vector<std::string>& values) {
  std::string out = "{";
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i) out.push_back(',');
    out.push_back('"');
    out.append(values[i]);
    out.push_back('"');
  }
  out.push_back('}');
  return out;
}

inline std::string pgBigintArray(const std::vector<std::int64_t>& values) {
  std::string out = "{";
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i) out.push_back(',');
    out.append(std::to_string(values[i]));
  }
  out.push_back('}');
  return out;
}

// Click counts aggregated in memory and flushed to PostgreSQL in batches.
// Lock striping keeps event-loop threads from contending on one mutex.
class ClickAggregator {
 public:
  static constexpr std::size_t kStripes = 64;

  void record(const std::string& code, std::int64_t count = 1) {
    Stripe& stripe = stripes_[fnv1a32(code) % kStripes];
    std::lock_guard<std::mutex> lock(stripe.mutex);
    stripe.counts[code] += count;
  }

  // Removes and returns everything recorded so far.
  std::vector<std::pair<std::string, std::int64_t>> drain() {
    std::vector<std::pair<std::string, std::int64_t>> out;
    for (Stripe& stripe : stripes_) {
      std::unordered_map<std::string, std::int64_t> taken;
      {
        std::lock_guard<std::mutex> lock(stripe.mutex);
        taken.swap(stripe.counts);
      }
      for (auto& entry : taken) out.emplace_back(entry.first, entry.second);
    }
    return out;
  }

  std::int64_t pending() {
    std::int64_t total = 0;
    for (Stripe& stripe : stripes_) {
      std::lock_guard<std::mutex> lock(stripe.mutex);
      for (auto& entry : stripe.counts) total += entry.second;
    }
    return total;
  }

 private:
  struct Stripe {
    std::mutex mutex;
    std::unordered_map<std::string, std::int64_t> counts;
  };
  std::array<Stripe, kStripes> stripes_;
};

}  // namespace wraplink
