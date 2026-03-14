# Jot Installation Guide

This guide covers all installation methods for Jot, from development setup to production deployment.

## Docker Installation (Recommended)

Docker provides the easiest installation and maintenance experience using the published image from Docker Hub.

### Prerequisites
- Docker 20.10+
- Docker Compose 2.0+ (optional but recommended)

### Quick Start

```bash
# Method 1: Using Docker Run
docker run -d \
  --name jot \
  -p 8080:8080 \
  -v ./data:/data \
  hanzei/jot:latest

# Method 2: Using Docker Compose
# 1. Create project directory
mkdir jot && cd jot

# 2. Download docker-compose.yml
curl -O https://raw.githubusercontent.com/hanzei/jot/master/docker-compose.yml

# 3. Start the application
docker-compose up -d

# 5. Access at http://localhost:8080
```

### Available Docker Images

The official images are automatically built and published to Docker Hub:

- **`hanzei/jot:latest`** - Latest stable release (recommended)
- **`hanzei/jot:pr-<number>`** - Pull request builds (for testing)
- **`hanzei/jot:<branch>-<sha>`** - Specific commit builds

### Building from Source

If you prefer to build the image locally:

```bash
git clone https://github.com/hanzei/jot.git
cd jot
docker build -t jot .
docker run -p 8080:8080 -v ./data:/data jot
```

## Configuration

### Environment Variables

#### Database Configuration
```bash
# Database file path (default: ./jot.db)
DB_PATH=/var/lib/jot/jot.db
```

#### Optional Configuration
```bash
# Server port (default: 8080)
PORT=8080

# Frontend static files directory (default: ../webapp/build/)
STATIC_DIR=/var/lib/jot/webapp

# Allowed CORS origin for the frontend (default: http://localhost:5173)
# Set this to the exact URL your frontend is served from (e.g. https://jot.example.com)
# Wildcards are not supported — must be an exact origin
CORS_ALLOWED_ORIGIN=https://jot.example.com

# Enable Secure flag on session cookies (default: true)
# Set to "false" only for local development over plain HTTP
# Must remain "true" in production (requires HTTPS)
COOKIE_SECURE=true

# Per-IP auth request limit for /register and /login (default: 30 requests/min)
# Set to 0 to disable rate limiting.
AUTH_RATE_LIMIT_PER_MINUTE=30

# Trust X-Forwarded-For header for auth rate limiting (default: false)
# Enable only behind a trusted reverse proxy that sanitizes this header.
TRUST_PROXY_HEADERS=false
```
