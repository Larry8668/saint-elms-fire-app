# Hosted SearXNG for the Philosopher's web search (Render service `sef-search`, render.yaml).
# Build context is the repo root (dockerContext: .), so paths are repo-relative.
# Pinned tag (2026-10-02 build, >2 weeks old); bump deliberately.
FROM searxng/searxng:2026.10.2-19ffbcd30

COPY infra/searxng/settings.yml /etc/searxng/settings.yml

# The image reads these at start (see docs/hosted-seat.md for the operator side):
#   SEARXNG_SECRET    overrides server.secret_key (set on Render via generateValue)
#   SEARXNG_BASE_URL  overrides server.base_url (the public https URL, trailing slash)
#   BIND_ADDRESS      host:port granian listens on; Render routes to PORT=8080
ENV BIND_ADDRESS=0.0.0.0:8080
EXPOSE 8080
