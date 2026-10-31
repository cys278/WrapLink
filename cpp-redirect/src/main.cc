// WrapLink C++ redirect service (Drogon + RapidJSON).
//
// Serves the hot path, GET /{code} -> 302, from the same Redis cache and
// PostgreSQL tables as the Node.js API. Link creation, authentication and
// rate limiting stay in Node; put both behind one proxy and route redirects
// here (see README.md).
//
// Why C++ for this path: a redirect does almost no work, so per-request
// framework overhead dominates. Drogon runs one event loop per core with no
// garbage collector and no cross-process hand-off, and RapidJSON serializes
// without allocations per field.
#include <drogon/drogon.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

#include "core.hpp"

using drogon::HttpRequestPtr;
using drogon::HttpResponse;
using drogon::HttpResponsePtr;

namespace {

wraplink::ClickAggregator gClicks;

// Mirrors INCREMENT_CACHED_CLICK in src/store/cached-link-store.ts.
const char* kIncrementCachedClick =
    "if redis.call('EXISTS', KEYS[1]) == 1 then "
    "return redis.call('HINCRBY', KEYS[1], 'clicks', 1) end return 0";

// HSET + PEXPIRE in one atomic step so a cache entry never lacks a TTL.
const char* kCacheLink =
    "redis.call('HSET', KEYS[1], 'code', ARGV[1], 'targetUrl', ARGV[2], "
    "'createdAt', ARGV[3], 'expiresAt', ARGV[4], 'clicks', ARGV[5]) "
    "redis.call('PEXPIRE', KEYS[1], ARGV[6]) return 1";

std::string env(const char* name, const char* fallback) {
  const char* value = std::getenv(name);
  return value && *value ? value : fallback;
}

int envInt(const char* name, int fallback) {
  const char* value = std::getenv(name);
  if (!value || !*value) return fallback;
  char* end = nullptr;
  const long parsed = std::strtol(value, &end, 10);
  if (*end != '\0' || parsed < 0 || parsed > 1000000) {
    LOG_FATAL << name << " must be a non-negative integer";
    std::exit(1);
  }
  return static_cast<int>(parsed);
}

std::int64_t nowMillis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

void securityHeaders(const HttpResponsePtr& response) {
  response->addHeader("content-security-policy", "default-src 'none'");
  response->addHeader("referrer-policy", "no-referrer");
  response->addHeader("x-content-type-options", "nosniff");
  response->addHeader("x-frame-options", "DENY");
}

HttpResponsePtr jsonResponse(drogon::HttpStatusCode status, const char* key,
                             const char* value) {
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key(key);
  writer.String(value);
  writer.EndObject();

  auto response = HttpResponse::newHttpResponse();
  response->setStatusCode(status);
  response->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  response->setBody(std::string(buffer.GetString(), buffer.GetSize()));
  securityHeaders(response);
  return response;
}

HttpResponsePtr redirectTo(const std::string& target) {
  auto response = HttpResponse::newRedirectionResponse(target, drogon::k302Found);
  securityHeaders(response);
  return response;
}

void recordClick(const std::string& code) {
  gClicks.record(code);

  auto redis = drogon::app().getRedisClient();
  redis->execCommandAsync(
      [](const drogon::nosql::RedisResult&) {},
      [](const std::exception& error) {
        LOG_WARN << "Could not update cached click count: " << error.what();
      },
      "EVAL %s 1 %s", kIncrementCachedClick, wraplink::linkKey(code).c_str());
}

void flushClicks() {
  auto batch = gClicks.drain();
  if (batch.empty()) return;

  std::vector<std::string> codes;
  std::vector<std::int64_t> counts;
  codes.reserve(batch.size());
  counts.reserve(batch.size());
  for (auto& entry : batch) {
    codes.push_back(entry.first);
    counts.push_back(entry.second);
  }

  // Same aggregated UPDATE as PostgresLinkStore.recordClickBatch().
  drogon::app().getDbClient()->execSqlAsync(
      "UPDATE links AS link SET clicks = link.clicks + batch.count "
      "FROM (SELECT code, count FROM UNNEST($1::text[], $2::bigint[]) "
      "AS v(code, count)) AS batch WHERE link.code = batch.code",
      [](const drogon::orm::Result&) {},
      [batch](const drogon::orm::DrogonDbException& error) {
        LOG_WARN << "Click flush failed; will retry: " << error.base().what();
        for (auto& entry : batch) gClicks.record(entry.first, entry.second);
      },
      wraplink::pgTextArray(codes), wraplink::pgBigintArray(counts));
}

void resolveFromDatabase(const std::string& code, int cacheTtlSeconds,
                         std::function<void(const HttpResponsePtr&)> callback) {
  drogon::app().getDbClient()->execSqlAsync(
      "SELECT target_url, "
      "to_char(created_at AT TIME ZONE 'UTC', "
      "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at, "
      "COALESCE(to_char(expires_at AT TIME ZONE 'UTC', "
      "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), '') AS expires_at, "
      "clicks::text AS clicks, "
      "COALESCE((EXTRACT(EPOCH FROM (expires_at - NOW())) * 1000)::bigint, 0) "
      "AS remaining_ms "
      "FROM links WHERE code = $1 "
      "AND (expires_at IS NULL OR expires_at > NOW())",
      [code, cacheTtlSeconds, callback](const drogon::orm::Result& result) {
        if (result.empty()) {
          callback(jsonResponse(drogon::k404NotFound, "error", "link not found"));
          return;
        }

        const auto row = result[0];
        const std::string target = row["target_url"].as<std::string>();
        std::int64_t ttlMs = static_cast<std::int64_t>(cacheTtlSeconds) * 1000;
        const std::int64_t remaining = row["remaining_ms"].as<std::int64_t>();
        if (remaining > 0) ttlMs = std::min(ttlMs, remaining);

        if (ttlMs > 0) {
          drogon::app().getRedisClient()->execCommandAsync(
              [](const drogon::nosql::RedisResult&) {},
              [](const std::exception& error) {
                LOG_WARN << "Could not cache link: " << error.what();
              },
              "EVAL %s 1 %s %s %s %s %s %s %s", kCacheLink,
              wraplink::linkKey(code).c_str(), code.c_str(), target.c_str(),
              row["created_at"].as<std::string>().c_str(),
              row["expires_at"].as<std::string>().c_str(),
              row["clicks"].as<std::string>().c_str(),
              std::to_string(ttlMs).c_str());
        }

        recordClick(code);
        callback(redirectTo(target));
      },
      [callback](const drogon::orm::DrogonDbException& error) {
        LOG_ERROR << "Link lookup failed: " << error.base().what();
        callback(jsonResponse(drogon::k503ServiceUnavailable, "error",
                              "temporarily unavailable"));
      },
      code);
}

void handleRedirect(const HttpRequestPtr&,
                    std::function<void(const HttpResponsePtr&)>&& callback,
                    const std::string& code, int cacheTtlSeconds) {
  if (!wraplink::isValidCode(code)) {
    callback(jsonResponse(drogon::k404NotFound, "error", "link not found"));
    return;
  }

  auto shared = std::make_shared<std::function<void(const HttpResponsePtr&)>>(
      std::move(callback));
  auto respond = [shared](const HttpResponsePtr& response) { (*shared)(response); };

  // Cache first; any Redis problem falls back to PostgreSQL, like Node.
  drogon::app().getRedisClient()->execCommandAsync(
      [code, cacheTtlSeconds, respond](const drogon::nosql::RedisResult& result) {
        if (result.type() == drogon::nosql::RedisResultType::kArray) {
          const auto fields = result.asArray();
          if (fields.size() == 2 && !fields[0].isNil()) {
            const std::string target = fields[0].asString();
            const std::string expires = fields[1].isNil() ? "" : fields[1].asString();
            const auto expiresAt = wraplink::parseIsoUtcMillis(expires);
            if (expires.empty() || (expiresAt && *expiresAt > nowMillis())) {
              recordClick(code);
              respond(redirectTo(target));
              return;
            }
          }
        }
        resolveFromDatabase(code, cacheTtlSeconds, respond);
      },
      [code, cacheTtlSeconds, respond](const std::exception& error) {
        LOG_WARN << "Redis read failed; using PostgreSQL: " << error.what();
        resolveFromDatabase(code, cacheTtlSeconds, respond);
      },
      "HMGET %s targetUrl expiresAt", wraplink::linkKey(code).c_str());
}

Json::Value buildConfig() {
  Json::Value config;

  Json::Value listener;
  listener["address"] = env("HOST", "0.0.0.0");
  listener["port"] = envInt("PORT", 5555);
  listener["https"] = false;
  config["listeners"].append(listener);

  Json::Value db;
  db["name"] = "default";
  db["rdbms"] = "postgresql";
  db["host"] = env("PGHOST", "127.0.0.1");
  db["port"] = envInt("PGPORT", 55432);
  db["dbname"] = env("PGDATABASE", "shortener");
  db["user"] = env("PGUSER", "shortener");
  db["passwd"] = env("PGPASSWORD", "shortener");
  db["is_fast"] = false;
  db["connection_number"] = envInt("PG_CONNECTIONS", 16);
  config["db_clients"].append(db);

  Json::Value redis;
  redis["name"] = "default";
  redis["host"] = env("REDIS_HOST", "127.0.0.1");
  redis["port"] = envInt("REDIS_PORT", 6379);
  redis["passwd"] = env("REDIS_PASSWORD", "");
  redis["db"] = 0;
  redis["is_fast"] = false;
  redis["number_of_connections"] = envInt("REDIS_CONNECTIONS", 16);
  redis["timeout"] = 2.0;
  config["redis_clients"].append(redis);

  Json::Value app;
  // 0 = one event loop per hardware thread.
  app["number_of_threads"] = envInt("THREADS", 0);
  app["enable_session"] = false;
  app["enable_server_header"] = false;
  // Redirects are tiny; compression only costs CPU here.
  app["use_gzip"] = false;
  app["use_brotli"] = false;
  app["log"]["log_level"] = env("LOG_LEVEL", "WARN");
  config["app"] = app;

  return config;
}

}  // namespace

int main() {
  const int cacheTtlSeconds = std::max(1, envInt("REDIS_CACHE_TTL_SECONDS", 300));
  const double flushSeconds =
      std::max(1, envInt("CLICK_FLUSH_INTERVAL_MS", 1000)) / 1000.0;

  drogon::app().loadConfigJson(buildConfig());

  drogon::app().registerHandler(
      "/health",
      [](const HttpRequestPtr&, std::function<void(const HttpResponsePtr&)>&& callback) {
        callback(jsonResponse(drogon::k200OK, "status", "ok"));
      },
      {drogon::Get});

  drogon::app().registerHandler(
      "/ready",
      [](const HttpRequestPtr&, std::function<void(const HttpResponsePtr&)>&& callback) {
        auto shared = std::make_shared<std::function<void(const HttpResponsePtr&)>>(
            std::move(callback));
        drogon::app().getDbClient()->execSqlAsync(
            "SELECT 1",
            [shared](const drogon::orm::Result&) {
              (*shared)(jsonResponse(drogon::k200OK, "status", "ready"));
            },
            [shared](const drogon::orm::DrogonDbException&) {
              (*shared)(jsonResponse(drogon::k503ServiceUnavailable, "status",
                                     "not_ready"));
            });
      },
      {drogon::Get});

  drogon::app().registerHandler(
      "/{code}",
      [cacheTtlSeconds](const HttpRequestPtr& request,
                        std::function<void(const HttpResponsePtr&)>&& callback,
                        const std::string& code) {
        handleRedirect(request, std::move(callback), code, cacheTtlSeconds);
      },
      {drogon::Get});

  drogon::app().registerBeginningAdvice([flushSeconds] {
    drogon::app().getLoop()->runEvery(flushSeconds, [] { flushClicks(); });
    LOG_WARN << "WrapLink C++ redirect service listening";
  });

  // Flush buffered clicks before exiting on SIGTERM/SIGINT.
  drogon::app().setTermSignalHandler([] {
    flushClicks();
    drogon::app().getLoop()->runAfter(1.0, [] { drogon::app().quit(); });
  });
  drogon::app().setIntSignalHandler([] {
    flushClicks();
    drogon::app().getLoop()->runAfter(1.0, [] { drogon::app().quit(); });
  });

  drogon::app().run();
  return 0;
}
