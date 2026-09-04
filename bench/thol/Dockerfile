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
      python3 python3-venv python3-pip python3-pytest python-is-python3 \
      git curl ca-certificates \
      jq sqlite3 ripgrep less procps \
    && rm -rf /var/lib/apt/lists/*

# THE BENCHMARK WAS MEASURING ITS OWN ENVIRONMENT. Captured with
# --output-format stream-json on the debug task, three of six tool calls were
# the agent fighting this image rather than doing the work:
#
#   python -m pytest        -> `python` did not exist, only python3
#   python3 -m pytest       -> pytest was not installed
#   pip install pytest; ... -> no network, so it hand-rolled a test runner
#
# The task prompt says to run `python -m pytest -q`, so every debug measurement
# taken before this line was substantially friction, not agent behaviour: the
# ~10 median turns, the 1.9x spread, and the "discretionary exploration"
# diagnosis all inherited it. python-is-python3 and python3-pytest make the
# stated command work, so what remains to measure is the agent.
RUN python3 -m pytest --version && python --version

# Claude Code is the harness under test. Pin it: leaderboard.py warns on mixed
# versions, and a campaign is only valid on a single client version.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION}

# Created before the runtime seeding below so that chown can name the user
# rather than guess a uid. Claude Code refuses --dangerously-skip-permissions
# as root, and every THOL run passes that flag.
RUN useradd -ms /bin/bash bench

# THE WORKING TREE, NOT THE REGISTRY.
#
# `npm run bench:build` packs this repo into thol/pkg/optimizer.tgz first, so the
# harness grades the code beside it. Installing from the registry instead meant
# the image could not measure anything unreleased -- and worse, could do so
# SILENTLY: an arm pinning a mode the published build does not recognise falls
# back to the default, so two arms become identical and the campaign produces a
# meaningless comparison rather than an error.
#
# To measure a published release, check out its tag and build from there.
COPY thol/pkg/optimizer.tgz /tmp/optimizer.tgz
# The tree that produced the tarball, so a result is attributable to exact
# content rather than to a version string that cannot tell two branches apart.
COPY thol/pkg/provenance.json /opt/optimizer-provenance.json
RUN npm install -g /tmp/optimizer.tgz

# The competitors, pinned, installed from the registry because that is how a
# user gets them.
#
# PRESENT IN EVERY IMAGE, INCLUDING THE ONE CONTROL RUNS ON, and that is
# deliberate: an arm is a settings file, so if a competitor were installed only
# for its own arm the image digest would differ between arms and the ledger
# would -- correctly -- refuse to compare them. Installed and unconfigured, they
# do nothing: control names no hooks, so nothing of theirs is ever invoked.
#
# Pinned rather than floating, for the same reason the optimizer tarball is
# built from this tree: `npm i -g name@latest` inside a rebuild would silently
# change what a competitor arm measured while the arm definition, the settings
# and the results file all still said the same thing.
#
# claude-token-optimizer's twelve hooks are shell scripts that live in the
# PROJECT (see bench/ledger/competitors/), but nine of them shell out to `cto`,
# so the package has to be here as well as the scaffold.
RUN npm install -g claude-token-optimizer@2.3.20 tokenjuice@0.8.1

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
    && npm install --prefix . --no-audit --no-fund /tmp/optimizer.tgz \
    && printf '%s' "${OPTIMIZER_VERSION}" > ${TOKEN_OPTIMIZER_RUNTIME}/current \
    && node -e "require('fs').writeFileSync(process.env.TOKEN_OPTIMIZER_RUNTIME + '/.last-refresh', String(Date.now()))" \
    && chown -R bench:bench ${TOKEN_OPTIMIZER_RUNTIME}

USER bench
WORKDIR /home/bench

# PINNED, because the harness is half of every measurement.
#
# Cloning the default branch meant a rebuild could pick up THOL task, fixture or
# scoring changes, so the same optimizer build would score differently on two
# days with nothing in this repo having changed -- which destroys the only thing
# a benchmark is for. Ratios are compared across campaigns; that comparison is
# meaningless if the ruler moves.
#
# Bumping this is a deliberate act that starts a NEW campaign: results either
# side of a bump are not comparable, and mixing them is the mistake the pin
# exists to prevent. Record the bump alongside the results it produced.
ARG THOL_REV=5ee6ea7f81dc21db1aae8d359cda3e1f7ded6dde
RUN git clone https://github.com/pi-infected/token-harness-optimizer-leaderboard.git thol \
    && git -C thol checkout --quiet ${THOL_REV} \
    && test "$(git -C thol rev-parse HEAD)" = "${THOL_REV}"

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
