# Node sandbox image for code-execution STEPs.
# Built by Engine/runner/images/build.sh as pona-flow-runner-node:latest.
#
# Deliberately minimal: no npm packages. All isolation comes from the docker-run
# flags applied by the runner (no network, non-root, read-only fs, cgroups,
# cap-drop, seccomp) — this image only provides the runtime and the harness.

FROM node:22-slim

USER 65534:65534

COPY harness.js /opt/pona/harness.js

ENTRYPOINT ["node", "/opt/pona/harness.js"]
