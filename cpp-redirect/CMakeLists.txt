cmake_minimum_required(VERSION 3.16)
project(wraplink_redirect CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(WRAPLINK_BUILD_SERVICE "Build the Drogon service (needs Drogon)" ON)

find_package(Threads REQUIRED)

# Dependency-free unit tests for the shared core.
add_executable(core_test test/core_test.cc)
target_include_directories(core_test PRIVATE src)
target_link_libraries(core_test PRIVATE Threads::Threads)
enable_testing()
add_test(NAME core_test COMMAND core_test)

if(WRAPLINK_BUILD_SERVICE)
  find_package(Drogon CONFIG REQUIRED)
  # RapidJSON is header-only; distro packages install it on the default
  # include path. Override with -DRAPIDJSON_INCLUDE_DIR=... if needed.
  find_path(RAPIDJSON_INCLUDE_DIR rapidjson/document.h REQUIRED)

  add_executable(wraplink_redirect src/main.cc)
  target_include_directories(wraplink_redirect PRIVATE src ${RAPIDJSON_INCLUDE_DIR})
  target_link_libraries(wraplink_redirect PRIVATE Drogon::Drogon)
endif()
