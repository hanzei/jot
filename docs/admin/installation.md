# Jot Installation Guide

This guide covers all installation methods for Jot, from development setup to production deployment.

## Installation 

Docker provides the easiest installation and maintenance experience.

#### Prerequisites
- Docker 20.10+
- Docker Compose 2.0+ (optional but recommended)

#### Quick Start
```bash
# 1. Create project directory
mkdir jot && cd jot

# 2. Download docker-compose.yml
curl -O https://raw.githubusercontent.com/hanzei/jot/refs/heads/master/docker-compose.yml

# 3. Create environment file
echo "JWT_SECRET=$(openssl rand -base64 32)" > .env

# 4. Start the application
docker-compose up -d

# 5. Access at http://localhost:8080
```

## Configuration

### Environment Variables

#### Required Configuration
```bash
# JWT secret key (generate with: openssl rand -base64 32)
JWT_SECRET=your-very-secure-secret-key-here

# Database file path
DB_PATH=/var/lib/jot/jot.db
```

#### Optional Configuration
```bash
# Server port (default: 8080)
PORT=8080

# Frontend static files directory (default: ../webapp/build/)
STATIC_DIR=/var/lib/jot/webapp

# Log level (default: info)
LOG_LEVEL=info
```
