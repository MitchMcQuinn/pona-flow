# Python sandbox image for code-execution STEPs.
# Built by Engine/runner/images/build.sh as pona-flow-runner-python:latest.
#
# The image is deliberately minimal: stdlib only, no pip packages, no shell tools
# beyond the base. All isolation comes from the docker-run flags applied by the
# runner (no network, non-root, read-only fs, cgroups, cap-drop, seccomp) — this
# image only provides the interpreter and the stdin/stdout harness.

FROM python:3.12-slim

# Run as nobody even if the runner forgets --user (defense in depth).
USER 65534:65534

COPY harness.py /opt/pona/harness.py

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["python3", "/opt/pona/harness.py"]
