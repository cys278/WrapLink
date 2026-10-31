// Unit tests for core.hpp, with no dependencies:
//   g++ -std=c++17 -O2 -pthread -Isrc test/core_test.cc -o core_test
// The vectors mirror test/fixtures/shard-vectors.json used by the Node tests,
// so both services provably compute identical Redis keys.
#include <cstdio>
#include <cstdlib>
#include <thread>

#include "core.hpp"

static int failures = 0;

#define CHECK(expr)                                                   \
  do {                                                                \
    if (!(expr)) {                                                    \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #expr); \
      ++failures;                                                     \
    }                                                                 \
  } while (0)

struct Vector {
  const char* code;
  std::uint32_t hash;
  std::uint32_t shard;
  const char* key;
};

int main() {
  using namespace wraplink;

  // Published FNV-1a reference values.
  CHECK(fnv1a32("") == 0x811c9dc5u);
  CHECK(fnv1a32("a") == 0xe40c292cu);
  CHECK(fnv1a32("foobar") == 0xbf9cf968u);

  const Vector vectors[] = {
    {"docs", 686503122u, 210u, "wraplink:link:{0210}:docs"},
    {"home", 3536372366u, 654u, "wraplink:link:{0654}:home"},
    {"container-demo", 1072479108u, 900u, "wraplink:link:{0900}:container-demo"},
    {"abcd", 3459545533u, 445u, "wraplink:link:{0445}:abcd"},
    {"0000000001", 1568696410u, 90u, "wraplink:link:{0090}:0000000001"},
    {"zZ9_-", 1400984964u, 388u, "wraplink:link:{0388}:zZ9_-"},
    {"temporary", 985042684u, 764u, "wraplink:link:{0764}:temporary"},
    {"Tq8kP2wXa", 2934103149u, 109u, "wraplink:link:{0109}:Tq8kP2wXa"},
    {"my_custom-alias", 1610118386u, 242u, "wraplink:link:{0242}:my_custom-alias"},
    {"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 3919010405u, 613u, "wraplink:link:{0613}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
  };
  for (const Vector& v : vectors) {
    CHECK(fnv1a32(v.code) == v.hash);
    CHECK(shardOf(v.code) == v.shard);
    CHECK(linkKey(v.code) == v.key);
  }

  CHECK(isValidCode("docs"));
  CHECK(isValidCode("my_custom-alias"));
  CHECK(!isValidCode("abc"));
  CHECK(!isValidCode("has space"));
  CHECK(!isValidCode("dots.not.ok"));
  CHECK(!isValidCode(std::string(33, 'a')));

  // Expected values computed with JavaScript's Date.parse().
  CHECK(parseIsoUtcMillis("1970-01-01T00:00:00.000Z") == 0);
  CHECK(parseIsoUtcMillis("2026-09-22T00:00:00.000Z") == 1790035200000LL);
  CHECK(parseIsoUtcMillis("2000-02-29T12:34:56.789Z") == 951827696789LL);
  CHECK(parseIsoUtcMillis("1999-12-31T23:59:59.999Z") == 946684799999LL);
  CHECK(!parseIsoUtcMillis(""));
  CHECK(!parseIsoUtcMillis("2026-09-22 00:00:00"));
  CHECK(!parseIsoUtcMillis("2026-13-01T00:00:00.000Z"));
  CHECK(!parseIsoUtcMillis("2026-09-2xT00:00:00.000Z"));

  CHECK(pgTextArray({"ab12", "cd34"}) == "{\"ab12\",\"cd34\"}");
  CHECK(pgBigintArray({1, 25}) == "{1,25}");
  CHECK(pgTextArray({}) == "{}");

  ClickAggregator clicks;
  std::vector<std::thread> threads;
  for (int t = 0; t < 8; ++t) {
    threads.emplace_back([&clicks] {
      for (int i = 0; i < 10000; ++i) clicks.record(i % 2 ? "even" : "odd1");
    });
  }
  for (auto& thread : threads) thread.join();
  CHECK(clicks.pending() == 80000);
  auto drained = clicks.drain();
  std::int64_t total = 0;
  for (auto& entry : drained) total += entry.second;
  CHECK(drained.size() == 2);
  CHECK(total == 80000);
  CHECK(clicks.pending() == 0);

  if (failures) {
    std::fprintf(stderr, "%d check(s) failed\n", failures);
    return EXIT_FAILURE;
  }
  std::puts("core_test: all checks passed");
  return EXIT_SUCCESS;
}
