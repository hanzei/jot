# Build stage
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Install dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the application
RUN CGO_ENABLED=1 GOOS=linux go build -a -installsuffix cgo -o main .

# Production stage
FROM alpine:latest

# Install ca-certificates and sqlite
RUN apk --no-cache add ca-certificates sqlite

WORKDIR /root/

# Copy the binary from builder
COPY --from=builder /app/main .
COPY --from=builder /app/migrations ./migrations

# Create data directory for SQLite database
RUN mkdir -p /data

# Expose port
EXPOSE 8080

# Set environment variables
ENV DB_PATH=/data/keep.db
ENV JWT_SECRET=change-this-in-production

# Run the binary
CMD ["./main"]