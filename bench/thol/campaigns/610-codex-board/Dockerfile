ARG BASE=thol-rig:pr610
FROM ${BASE}
USER root
RUN npm install -g @openai/codex@0.169.0 && codex --version
USER bench
WORKDIR /home/bench
ENTRYPOINT ["python3", "/campaign/run.py"]
