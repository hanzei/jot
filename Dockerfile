# Multi-stage build for Jot application
FROM node:18-alpine AS frontend-builder

WORKDIR /app/webapp

# Copy frontend package files
COPY webapp/package*.json ./

# Install frontend dependencies
RUN npm ci --only=production

# Copy frontend source code
COPY webapp/ ./

# Build the frontend
RUN npm run build

# Backend build stage
FROM golang:1.21-alpine AS backend-builder

WORKDIR /app

# Install dependencies for CGO (SQLite)
RUN apk add --no-cache gcc musl-dev sqlite-dev

# Copy backend files
COPY server/go.mod server/go.sum ./
RUN go mod download

# Copy backend source code
COPY server/ ./

# Build the backend
RUN CGO_ENABLED=1 GOOS=linux go build -a -installsuffix cgo -o main .

# Production stage
FROM alpine:latest

# Install runtime dependencies
RUN apk --no-cache add ca-certificates sqlite

WORKDIR /app

# Copy the backend binary
COPY --from=backend-builder /app/main ./
COPY --from=backend-builder /app/migrations ./migrations/

# Copy the built frontend files
COPY --from=frontend-builder /app/webapp/build ./webapp/build/

# Create data directory for SQLite database
RUN mkdir -p /data

# Expose port
EXPOSE 8080

# Set environment variables
ENV DB_PATH=/data/jot.db
ENV JWT_SECRET=change-this-in-production
ENV STATIC_DIR=/app/webapp/build

# Run the application
CMD ["./main"]