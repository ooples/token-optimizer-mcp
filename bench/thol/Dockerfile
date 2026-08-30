# THOL benchmark rig for token-optimizer-mcp.
#
# THOL assumes a Linux host: /tmp sandboxes, `sh -c` installers, and a
# sanitized PATH. This image reproduces that faithfully so the numbers we get
# are comparable in shape to a submittable campaign.
#
# We install ONLY what our three arms need (control, token-optimizer-mcp
# enforced, token-optimizer-mcp with enforcement off). The Rust/uv toolchain
# in THOL's setup/install_competitors.sh exists for codegraph, rtk, squeez,
# graphify, headroom and code-review-graph -- none of which we are measuring --
# so it is deliberately skipped. Adding it back is a one-line RUN if we ever
# want to reproduce the full board locally.

FROM node:22-bookworm

ARG CLAUDE_VERSION=2.1.251
# 6.0.2 is npm dist-tag `latest` as of 2026-08-29 -- what a user installing
# today actually receives, which is what the benchmark should measure.
ARG OPTIMIZER_VERSION=6.0.2

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip git curl ca-certificates \
      jq sqlite3 ripgrep less procps \
    && rm -rf /var/lib/apt/lists/*

# Claude Code is the harness under test. Pin it: leaderboard.py warns on mixed
# versions, and a campaign is only valid on a single client version.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION}

# Created before the runtime seeding below so that chown can name the user
# rather than guess a uid. Claude Code refuses --dangerously-skip-permissions
# as root, and every THOL run passes that flag.
RUN useradd -ms /bin/bash bench

# Our tool, installed globally the way install_competitors.sh installs every
# other competitor that needs a binary on PATH before a run.
RUN npm install -g @ooples/token-optimizer-mcp@${OPTIMIZER_VERSION}

# Pre-seed a SHARED managed runtime for plugin/launch.mjs.
#
# Why this is required, and not an optimisation. launch.mjs does not serve the
# globally-installed copy: on a cold runtime it logs "no cached server;
# installing latest" and npm-installs @latest into its own versions dir. Two
# consequences for a benchmark, both fatal:
#   1. version_pin becomes a fiction -- an image pinned to 6.0.1 measured 6.0.2;
#   2. THOL gives every run a throwaway HOME, so the default runtime location
#      (~/.token-optimizer/runtime) is empty on all 153 runs -- meaning 153
#      cold npm installs, ~18s each, and a tool that can change under the
#      campaign if anything is published mid-run.
#
# Seeding the layout launch.mjs expects (versions/<v>/node_modules/<pkg>, plus
# a `current` marker) and pointing TOKEN_OPTIMIZER_RUNTIME at it outside the
# sandbox HOME fixes all three, while still exercising the real shipped launch
# path rather than bypassing it.
#
# .last-refresh must be seeded too: refreshDueNow() returns TRUE when the
# marker is unreadable (plugin/launch.mjs, the `catch` falls through to
# `return true`), so a large REFRESH_INTERVAL_MS alone does not pin anything.
ENV TOKEN_OPTIMIZER_RUNTIME=/opt/token-optimizer-runtime
RUN mkdir -p ${TOKEN_OPTIMIZER_RUNTIME}/versions/${OPTIMIZER_VERSION} \
    && cd ${TOKEN_OPTIMIZER_RUNTIME}/versions/${OPTIMIZER_VERSION} \
    && npm install --prefix . --no-audit --no-fund \
         @ooples/token-optimizer-mcp@${OPTIMIZER_VERSION} \
    && printf '%s' "${OPTIMIZER_VERSION}" > ${TOKEN_OPTIMIZER_RUNTIME}/current \
    && node -e "require('fs').writeFileSync(process.env.TOKEN_OPTIMIZER_RUNTIME + '/.last-refresh', String(Date.now()))" \
    && chown -R bench:bench ${TOKEN_OPTIMIZER_RUNTIME}

USER bench
WORKDIR /home/bench

RUN git clone --depth 1 https://github.com/pi-infected/token-harness-optimizer-leaderboard.git thol

# THOL ships no requirements.txt: fixtures/generate_fixtures.py, tasks/_vlib.py
# and every verify.py import stdlib only. So there is nothing to pip install,
# and no venv is needed to work around Debian's PEP 668 protection.
ENV THOL_HOME=/home/bench/thol

# Pin the optimizer's warm-launch shim to the installed copy. launch.mjs
# background-refreshes to @latest every 6h by default, which would let the
# measured version drift mid-campaign; a very large interval makes it serve the
# pinned build until the runtime dir is cleared. This keeps the faithful launch
# path (what real users run) while satisfying THOL's version_pin requirement.
ENV TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS=999999999999

# Paths are relative to the build context, which is `bench/` -- so builds run as
# `docker build -f bench/thol/Dockerfile bench/`. The rig this came from used
# `bench/` as both context and script root; here the scripts live one level
# deeper, under thol/.
COPY --chown=bench:bench thol/entrypoint.sh /home/bench/scripts/entrypoint.sh
COPY --chown=bench:bench thol/manifests/ /home/bench/manifests/

ENTRYPOINT ["/bin/bash", "/home/bench/scripts/entrypoint.sh"]
CMD ["selftest"]
