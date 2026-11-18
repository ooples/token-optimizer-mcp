FROM thol-codex:pr610
USER root
# Installation is separate from activation. Lifecycle scripts never run while
# package-manager network access is available. No host auth/home is mounted.
RUN npm install -g --ignore-scripts @colbymchenry/codegraph@1.6.3 claude-mem@15.21.0
RUN uv tool install --force --no-build graphifyy==0.9.112
RUN npm install -g --ignore-scripts @oven/bun-linux-x64@1.4.4 && ln -s /usr/local/lib/node_modules/@oven/bun-linux-x64/bin/bun /usr/local/bin/bun
COPY --chown=bench:bench vendor /opt/qualification-vendor
RUN cd /opt/qualification-vendor/caveman && npm install --ignore-scripts --omit=dev && npm install --ignore-scripts --omit=dev @caveman-ai/cli@4.1.0
RUN npm install -g --ignore-scripts skills@1.9.0
RUN npm install -g --ignore-scripts token-optimizer@0.2.2
ENV BUN_INSTALL_CACHE_DIR=/opt/qualification-cache/bun
RUN cd /usr/local/lib/node_modules/claude-mem/plugin && bun install --ignore-scripts --frozen-lockfile && chown -R bench:bench /opt/qualification-cache
# Public Git objects are preparation inputs. Activation uses these exact mirrors
# with URL rewriting; vendor source/manifests are unchanged.
RUN git clone --depth 1 --branch v4.1.0 --bare https://github.com/JuliusBrussee/caveman.git /opt/qualification-git/caveman && git clone --depth 1 --bare https://github.com/DietrichGebert/ponytail.git /opt/qualification-git/ponytail
USER bench
WORKDIR /home/bench
ENTRYPOINT ["python3", "/qualification/probe.py"]
