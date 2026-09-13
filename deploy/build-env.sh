#!/usr/bin/env bash
#
# The VITE_* values baked into the PRODUCTION bundle — ONE source of truth, because two would be a
# silent bug rather than a loud one.
#
# `vite build` compiles these INTO the JavaScript, so they are part of the artifact's identity: a
# bundle built with a different signaling URL is a different bundle with a different hash. The whole
# point of the CI build-and-attest job is that the hash CI publishes matches the hash the deploy host
# produces, so both sides MUST build with identical values. If this file and the workflow ever drift,
# the hashes stop matching and the published attestation becomes unverifiable noise — so both read
# here instead of each carrying their own copy.
#
# Sourced by:
#   - deploy/deploy-frontend.sh   (the live deploy)
#   - .github/workflows/ci.yml    (the independent build whose hashes are published + attested)
#
# Every value stays overridable from the environment, so a fork or a staging host can build its own
# variant without editing a tracked file.

VITE_SIGNALING_URL="${VITE_SIGNALING_URL:-wss://hushsend.frelikh.dev/ws}"
VITE_STUN_URLS="${VITE_STUN_URLS:-stun:turn.hushsend.frelikh.dev:3478}"
export VITE_SIGNALING_URL VITE_STUN_URLS
