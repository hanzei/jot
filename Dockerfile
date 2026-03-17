# syntax=docker/dockerfile:1

# Multi-stage build for Jot application
FROM node:24-alpine AS frontend-builder

WORKDIR /app/webapp

# Copy shared package (dependency of webapp)
COPY shared/ ../shared/

# Copy frontend package files
COPY webapp/package*.json ./

# Install frontend dependencies (including dev dependencies for build)
RUN npm ci

# Copy frontend source code
COPY webapp/ ./

# Build the frontend
RUN npm run build

# Backend build stage
FROM golang:1.25-alpine AS backend-builder

WORKDIR /src

# Install dependencies for CGO (SQLite)
RUN apk add --no-cache gcc musl-dev sqlite-dev

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
    cd server && CGO_ENABLED=1 GOOS=linux go build \
    -buildvcs=false \
    -ldflags "-s -w \
      -X 'github.com/hanzei/jot/server/internal/server.commit=${COMMIT_SHA}' \
      -X 'github.com/hanzei/jot/server/internal/server.version=${VERSION}' \
      -X 'github.com/hanzei/jot/server/internal/server.buildTime=${BUILD_DATE}'" \
    -o main .

# Production stage
FROM alpine:latest

# Install runtime dependencies
RUN apk --no-cache add ca-certificates sqlite

WORKDIR /app

# Copy the backend binary
COPY --from=backend-builder /src/server/main ./

# Copy the built frontend files
COPY --from=frontend-builder /app/webapp/build ./webapp/build/

# Create data directory for SQLite database
RUN mkdir -p /data

# Expose port
EXPOSE 8080

# Set environment variables
ENV DB_PATH=/data/jot.db
ENV STATIC_DIR=/app/webapp/build

# Run the application
CMD ["./main"]
