# syntax=docker/dockerfile:1

# Multi-stage build for Jot application
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS frontend-builder

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

# Build the frontend
RUN npm run build

# Backend build stage
FROM golang:1.26-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS backend-builder

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
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

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
