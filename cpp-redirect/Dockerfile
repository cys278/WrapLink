# Builds Drogon from source (with PostgreSQL and Redis support) and the
# WrapLink redirect service. A single stage keeps the runtime libraries
# exactly matched to the build; the image is larger than a slim runtime.
FROM ubuntu:24.04

ARG DROGON_VERSION=v1.9.10
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
      libjsoncpp-dev uuid-dev zlib1g-dev libssl-dev \
      libpq-dev libhiredis-dev libbrotli-dev libc-ares-dev \
      rapidjson-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${DROGON_VERSION}" --recurse-submodules \
      https://github.com/drogonframework/drogon /tmp/drogon \
    && cmake -S /tmp/drogon -B /tmp/drogon/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_EXAMPLES=OFF -DBUILD_CTL=OFF -DBUILD_TESTING=OFF \
      -DBUILD_POSTGRESQL=ON -DBUILD_REDIS=ON \
      -DBUILD_MYSQL=OFF -DBUILD_SQLITE=OFF \
    && cmake --build /tmp/drogon/build -j"$(nproc)" \
    && cmake --install /tmp/drogon/build \
    && rm -rf /tmp/drogon

WORKDIR /src
COPY CMakeLists.txt ./
COPY src ./src
COPY test ./test

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)" \
    && ./build/core_test \
    && install -m 0755 build/wraplink_redirect /usr/local/bin/wraplink_redirect

RUN useradd --system --no-create-home wraplink
USER wraplink

EXPOSE 5555
CMD ["/usr/local/bin/wraplink_redirect"]
