# Canvas Core — centralized control plane / AI brain (Phase 2).
# Node 20 Alpine, matching the legacy server's base for consistency.
FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip make g++ git ca-certificates

# ---------------------------------------------------------------------------
# Install au-weather-mcp (craigles75) at the pinned commit so Core can spawn
# it as a stdio child process via StdioMcpClient — no separate HTTP sidecar.
# ---------------------------------------------------------------------------
ARG AU_WEATHER_MCP_COMMIT=c88cba1a295b22d53fc50a90adf616d328a5d1ae
RUN git clone https://github.com/craigles75/au-weather-mcp.git /opt/au-weather-mcp \
 && cd /opt/au-weather-mcp \
 && git checkout "$AU_WEATHER_MCP_COMMIT" \
 && pip3 install --no-cache-dir --break-system-packages \
      'mcp>=1.2.0,<2.0.0' 'requests>=2.31.0' \
      'httpx>=0.27.0' 'beautifulsoup4>=4.12' 'lxml>=5.0' \
 && pip3 install --no-cache-dir --break-system-packages --no-deps -e /opt/au-weather-mcp \
 && apk del git \
 && rm -rf /opt/au-weather-mcp/.git /root/.cache

WORKDIR /app

COPY core/package*.json ./
RUN npm install

COPY core/tsconfig.json ./
COPY core/src ./src
COPY core/public ./public
COPY tests/hermes ./tests/hermes

# Stdio runner for au-weather-mcp (replaces the HTTP bridge sidecar).
COPY core/au_weather_stdio.py ./au_weather_stdio.py

# Bowling MCP — live ComputerScore scraper, no database.
COPY core/bowling_mcp.py ./bowling_mcp.py

# Build is done locally — the dist/ directory is copied from the host.
# This avoids TypeScript compilation issues in the Docker build environment.
# To rebuild: cd core && npm run build && docker compose up -d --build
COPY core/dist ./dist

EXPOSE 3100

CMD ["node", "dist/index.js"]
