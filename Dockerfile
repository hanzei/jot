# syntax=docker/dockerfile:1

# Multi-stage build for Jot application
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS frontend-builder

WORKDIR /app/webapp

# Manifests first, sources after: `npm ci` then re-runs only when a lockfile
# changes, not on every edit to webapp/src or shared/src. shared's manifest is
# part of this step because webapp depends on it through `file:../shared`, so
# npm needs it present to resolve the link.
COPY shared/package*.json ../shared/
COPY webapp/package*.json ./

# Install frontend dependencies (including dev dependencies for build)
RUN npm ci

# Copy shared package source (compiled directly by the webapp build) and the
# frontend source
COPY shared/ ../shared/
COPY webapp/ ./

# Build the frontend, stamped with the same version and commit as the server
# so Settings > About can show a stale cached bundle. Declared after
# `npm ci` so a new commit does not invalidate the install layer.
ARG COMMIT_SHA=unknown
ARG VERSION=dev
RUN JOT_BUILD_VERSION="${VERSION}" JOT_BUILD_COMMIT="${COMMIT_SHA}" npm run build

# Backend build stage
FROM golang:1.27-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS backend-builder

WORKDIR /src

ARG COMMIT_SHA=unknown
ARG VERSION=dev
ARG BUILD_DATE=""
ARG TARGETARCH

# Copy backend files
COPY server/go.mod server/go.sum ./server/
RUN --mount=type=cache,id=gomodcache-${TARGETARCH},target=/go/pkg/mod \
    cd server && go mod download

# Copy backend source code
COPY server/ server/

# Build the backend
RUN --mount=type=cache,id=gomodcache-${TARGETARCH},target=/go/pkg/mod \
    --mount=type=cache,id=gobuildcache-${TARGETARCH},target=/root/.cache/go-build \
    cd server && CGO_ENABLED=0 GOOS=linux go build \
    -buildvcs=false \
    -ldflags "-s -w \
      -X 'github.com/hanzei/jot/server/internal/server.commit=${COMMIT_SHA}' \
      -X 'github.com/hanzei/jot/server/internal/server.version=${VERSION}' \
      -X 'github.com/hanzei/jot/server/internal/server.buildTime=${BUILD_DATE}'" \
    -o main .

# Production stage
FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

# Install runtime dependencies
RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy the backend binary
COPY --from=backend-builder /src/server/main ./

# Copy the built frontend files
COPY --from=frontend-builder /app/webapp/build ./webapp/build/

# Create data directory for SQLite database and uploaded blobs
RUN mkdir -p /data/uploads

# Expose port
EXPOSE 8080

# Set environment variables
ENV JOT_DB_DSN=/data/jot.db
ENV JOT_UPLOAD_DIR=/data/uploads
ENV JOT_STATIC_DIR=/app/webapp/build

# Run the application
CMD ["./main"]
