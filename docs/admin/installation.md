# Keep Installation Guide

This guide covers all installation methods for Keep, from development setup to production deployment.

## System Requirements

### Minimum Requirements
- **CPU**: 1 core, 1GHz or faster
- **RAM**: 512MB available memory
- **Storage**: 100MB for application + database space
- **Network**: HTTP/HTTPS access for users

### Recommended Requirements
- **CPU**: 2+ cores, 2GHz or faster
- **RAM**: 1GB+ available memory
- **Storage**: 1GB+ for application and database growth
- **Network**: HTTPS with SSL certificate

### Supported Platforms
- **Linux**: Ubuntu 20.04+, CentOS 8+, Debian 10+, Alpine Linux
- **macOS**: 10.15+ (Catalina and later)
- **Windows**: Windows 10/11, Windows Server 2019+
- **Docker**: Any platform supporting Docker

## Installation Methods

### Method 1: Docker (Recommended)

Docker provides the easiest installation and maintenance experience.

#### Prerequisites
- Docker 20.10+
- Docker Compose 2.0+ (optional but recommended)

#### Quick Start
```bash
# 1. Create project directory
mkdir keep && cd keep

# 2. Download docker-compose.yml
curl -O https://raw.githubusercontent.com/your-repo/keep/main/docker-compose.yml

# 3. Create environment file
echo "JWT_SECRET=$(openssl rand -base64 32)" > .env

# 4. Start the application
docker-compose up -d

# 5. Access at http://localhost:8080
```

#### Custom Docker Compose
```yaml
# docker-compose.yml
version: '3.8'

services:
  keep:
    image: keep:latest  # or build from source
    container_name: keep
    environment:
      - DB_PATH=/data/keep.db
      - JWT_SECRET=${JWT_SECRET}
      - PORT=8080
    volumes:
      - ./data:/data
      - ./backups:/backups  # optional backup directory
    ports:
      - "8080:8080"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  data:
    driver: local
```

### Method 2: Binary Installation

Direct installation using pre-compiled binaries.

#### Download Binary
```bash
# Download latest release
wget https://github.com/your-repo/keep/releases/latest/download/keep-linux-amd64
chmod +x keep-linux-amd64
mv keep-linux-amd64 /usr/local/bin/keep

# Or for other platforms:
# keep-darwin-amd64 (macOS)
# keep-windows-amd64.exe (Windows)
```

#### Create Service User
```bash
# Create dedicated user
sudo useradd --system --home-dir /var/lib/keep --create-home keep
sudo usermod --shell /usr/sbin/nologin keep

# Create directories
sudo mkdir -p /var/lib/keep /var/log/keep /etc/keep
sudo chown keep:keep /var/lib/keep /var/log/keep
```

#### Configuration File
```bash
# /etc/keep/config.env
DB_PATH=/var/lib/keep/keep.db
JWT_SECRET=your-very-secure-secret-key-here
PORT=8080
```

#### Systemd Service
```ini
# /etc/systemd/system/keep.service
[Unit]
Description=Keep Note-Taking Application
After=network.target
Wants=network.target

[Service]
Type=simple
User=keep
Group=keep
WorkingDirectory=/var/lib/keep
EnvironmentFile=/etc/keep/config.env
ExecStart=/usr/local/bin/keep
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Security settings
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/keep /var/log/keep

[Install]
WantedBy=multi-user.target
```

#### Start Service
```bash
sudo systemctl daemon-reload
sudo systemctl enable keep
sudo systemctl start keep
sudo systemctl status keep
```

### Method 3: Source Installation

Build and install from source code.

#### Prerequisites
- Go 1.21+
- Node.js 18+
- npm
- Git

#### Build Process
```bash
# 1. Clone repository
git clone https://github.com/your-repo/keep.git
cd keep

# 2. Build frontend
cd webapp
npm install
npm run build
cd ..

# 3. Build backend
cd server
go mod tidy
go build -o keep main.go
cd ..

# 4. Install binary
sudo cp server/keep /usr/local/bin/
sudo chmod +x /usr/local/bin/keep

# 5. Copy frontend files
sudo mkdir -p /var/lib/keep/webapp
sudo cp -r webapp/build/* /var/lib/keep/webapp/
sudo chown -R keep:keep /var/lib/keep
```

## Configuration

### Environment Variables

#### Required Configuration
```bash
# JWT secret key (generate with: openssl rand -base64 32)
JWT_SECRET=your-very-secure-secret-key-here

# Database file path
DB_PATH=/var/lib/keep/keep.db
```

#### Optional Configuration
```bash
# Server port (default: 8080)
PORT=8080

# Frontend static files directory (default: ../webapp/build/)
STATIC_DIR=/var/lib/keep/webapp

# Log level (default: info)
LOG_LEVEL=info
```

### Security Configuration

#### JWT Secret Generation
```bash
# Generate secure JWT secret
openssl rand -base64 32

# Or using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Or using Python
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

#### File Permissions
```bash
# Application binary
chmod 755 /usr/local/bin/keep

# Configuration files
chmod 600 /etc/keep/config.env
chown root:keep /etc/keep/config.env

# Database directory
chmod 755 /var/lib/keep
chmod 644 /var/lib/keep/keep.db
chown -R keep:keep /var/lib/keep

# Log directory
chmod 755 /var/log/keep
chown keep:keep /var/log/keep
```

## Database Setup

### Automatic Migration
Keep automatically runs database migrations on startup:

```bash
# Check migration status in logs
sudo journalctl -u keep -f

# Or for Docker
docker logs keep
```

### Manual Database Operations

#### Backup Database
```bash
# SQLite backup
sqlite3 /var/lib/keep/keep.db ".backup backup-$(date +%Y%m%d).db"

# Or using cp (stop service first)
sudo systemctl stop keep
cp /var/lib/keep/keep.db /backups/keep-backup-$(date +%Y%m%d).db
sudo systemctl start keep
```

#### Restore Database
```bash
# Stop service
sudo systemctl stop keep

# Restore from backup
cp /backups/keep-backup-20240101.db /var/lib/keep/keep.db
chown keep:keep /var/lib/keep/keep.db

# Start service
sudo systemctl start keep
```

#### Reset Database
```bash
# WARNING: This deletes all data
sudo systemctl stop keep
sudo rm /var/lib/keep/keep.db
sudo systemctl start keep
```

## Reverse Proxy Setup

### Nginx Configuration

#### Basic Configuration
```nginx
# /etc/nginx/sites-available/keep
server {
    listen 80;
    server_name your-domain.com;
    
    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    # SSL configuration
    ssl_certificate /etc/ssl/certs/your-domain.crt;
    ssl_certificate_key /etc/ssl/private/your-domain.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    
    # Proxy to Keep application
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket support (if needed in future)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    
    # Optional: serve static files directly from Nginx
    location /static/ {
        alias /var/lib/keep/webapp/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

#### Enable Site
```bash
sudo ln -s /etc/nginx/sites-available/keep /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Caddy Configuration

#### Caddyfile
```caddy
# /etc/caddy/Caddyfile
your-domain.com {
    reverse_proxy localhost:8080
    
    # Security headers
    header {
        X-Frame-Options SAMEORIGIN
        X-XSS-Protection "1; mode=block"
        X-Content-Type-Options nosniff
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
    }
    
    # Logging
    log {
        output file /var/log/caddy/keep.log
        format json
    }
}
```

### Traefik Configuration

#### Docker Compose with Traefik
```yaml
version: '3.8'

services:
  keep:
    image: keep:latest
    container_name: keep
    environment:
      - DB_PATH=/data/keep.db
      - JWT_SECRET=${JWT_SECRET}
    volumes:
      - ./data:/data
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.keep.rule=Host(`your-domain.com`)"
      - "traefik.http.routers.keep.tls=true"
      - "traefik.http.routers.keep.tls.certresolver=letsencrypt"
      - "traefik.http.services.keep.loadbalancer.server.port=8080"
    networks:
      - traefik

networks:
  traefik:
    external: true
```

## Monitoring and Maintenance

### Health Checks
```bash
# Check application health
curl -f http://localhost:8080/health || exit 1

# Check database connectivity
sqlite3 /var/lib/keep/keep.db "SELECT 1;" || exit 1

# Check disk space
df -h /var/lib/keep
```

### Log Management
```bash
# View recent logs
sudo journalctl -u keep -n 50

# Follow logs in real-time
sudo journalctl -u keep -f

# View logs by date
sudo journalctl -u keep --since "2024-01-01" --until "2024-01-31"

# Rotate logs (systemd handles this automatically)
sudo systemctl restart systemd-journald
```

### Backup Strategy
```bash
#!/bin/bash
# /usr/local/bin/keep-backup.sh

# Configuration
BACKUP_DIR="/backups/keep"
RETENTION_DAYS=30
DB_PATH="/var/lib/keep/keep.db"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Create backup
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/keep_backup_$DATE.db"

# Backup database
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Compress backup
gzip "$BACKUP_FILE"

# Clean old backups
find "$BACKUP_DIR" -name "keep_backup_*.db.gz" -mtime +$RETENTION_DAYS -delete

echo "Backup completed: ${BACKUP_FILE}.gz"
```

#### Cron Job for Automated Backups
```bash
# Add to crontab (sudo crontab -e)
# Daily backup at 2 AM
0 2 * * * /usr/local/bin/keep-backup.sh >> /var/log/keep-backup.log 2>&1
```

## Troubleshooting Installation

### Common Issues

#### Port Already in Use
```bash
# Check what's using port 8080
sudo netstat -tulpn | grep :8080
sudo lsof -i :8080

# Use different port
PORT=8081 keep
```

#### Permission Denied
```bash
# Fix file permissions
sudo chown -R keep:keep /var/lib/keep
sudo chmod 644 /var/lib/keep/keep.db
sudo chmod 755 /var/lib/keep
```

#### Database Connection Failed
```bash
# Check database file exists and permissions
ls -la /var/lib/keep/keep.db
sqlite3 /var/lib/keep/keep.db ".schema"

# Check disk space
df -h /var/lib/keep
```

#### Service Won't Start
```bash
# Check service status
sudo systemctl status keep

# View detailed logs
sudo journalctl -u keep -n 50

# Check configuration
sudo -u keep keep --help  # if available
```

### Getting Help

1. **Check logs**: Always start with system logs
2. **Verify configuration**: Ensure all required environment variables are set
3. **Test connectivity**: Use health check endpoint
4. **Check resources**: Ensure adequate CPU, RAM, and disk space
5. **Review documentation**: Check the main README and this guide

---

Your Keep installation should now be ready for production use! 🚀