# Multi-stage build for Jot application
FROM node:22-alpine AS frontend-builder

WORKDIR /app/webapp

# Copy frontend package files
COPY webapp/package*.json ./

# Install frontend dependencies (including dev dependencies for build)
RUN npm ci

# Copy frontend source code
COPY webapp/ ./

# Build the frontend
RUN npm run build

# Backend build stage
FROM golang:1.24-alpine AS backend-builder

WORKDIR /src

# Install dependencies for CGO (SQLite) and git for VCS build info
RUN apk add --no-cache gcc musl-dev sqlite-dev git

# Copy backend files
COPY server/go.mod server/go.sum ./server/
RUN cd server && go mod download

# Copy .git and backend source code (Go embeds VCS info via debug.ReadBuildInfo)
COPY .git .git
COPY server/ server/

# Build the backend
RUN cd server && CGO_ENABLED=1 GOOS=linux go build -a -installsuffix cgo \
    -ldflags "-s -w" \
    -o main .

# Production stage
FROM alpine:latest

# Install runtime dependencies
RUN apk --no-cache add ca-certificates sqlite

WORKDIR /app

# Copy the backend binary
COPY --from=backend-builder /src/server/main ./
COPY --from=backend-builder /src/server/migrations ./migrations/

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