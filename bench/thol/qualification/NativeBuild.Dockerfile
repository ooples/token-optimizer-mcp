FROM rust:1-bookworm AS source-build
COPY vendor/trs /src/trs
COPY vendor/tokf /src/tokf
# cargo fetch downloads source only. All build scripts and proc macros execute
# in later network-denied layers, without user HOME or provider credentials.
RUN cargo fetch --locked --manifest-path /src/trs/Cargo.toml && cargo fetch --locked --manifest-path /src/tokf/Cargo.toml
RUN --network=none cargo build --offline --locked --release --manifest-path /src/trs/Cargo.toml --bin trs
RUN --network=none cargo build --offline --locked --release --manifest-path /src/tokf/Cargo.toml --bin tokf
RUN mkdir /out && cp /src/trs/target/release/trs /out/trs && cp /src/tokf/target/release/tokf /out/tokf && rustc --version >/out/compiler.txt && sha256sum /out/trs /out/tokf >/out/SHA256SUMS
FROM scratch
COPY --from=source-build /out/ /
