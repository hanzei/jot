# Keep Configuration Guide

This guide covers all configuration options for Keep administrators, including environment variables, security settings, and performance tuning.

## Configuration Overview

Keep uses environment variables for configuration, making it easy to deploy across different environments without code changes.

## Environment Variables

### Required Configuration

#### JWT_SECRET
**Purpose**: Signs and verifies JWT authentication tokens
**Required**: Yes
**Security**: Critical - change from default!

```bash
# Generate secure secret
JWT_SECRET=$(openssl rand -base64 32)

# Example
JWT_SECRET="vx8rP2mF9kL3nQ7sW1yT4zA6bC5dE8fG2hJ1mN0pO9qR"
```

**Security Notes**:
- Must be at least 32 characters
- Use cryptographically secure random generation
- Keep secret and don't commit to version control
- Change immediately if compromised

#### DB_PATH
**Purpose**: Location of SQLite database file
**Required**: Yes (has default)
**Default**: `./keep.db`

```bash
# Development
DB_PATH="./keep.db"

# Production
DB_PATH="/var/lib/keep/keep.db"

# Docker
DB_PATH="/data/keep.db"
```

**Best Practices**:
- Use absolute paths in production
- Ensure directory exists and is writable
- Place on persistent storage for Docker
- Include in backup strategy

### Optional Configuration

#### PORT
**Purpose**: HTTP server listening port
**Default**: `8080`
**Range**: 1-65535 (use 1024+ for non-root)

```bash
# Standard web port (requires root or capabilities)
PORT=80

# Standard HTTPS port (use with reverse proxy)
PORT=8080

# Alternative port
PORT=3000
```

#### STATIC_DIR
**Purpose**: Directory containing frontend build files
**Default**: `../webapp/build/`

```bash
# Development (relative to server binary)
STATIC_DIR="../webapp/build/"

# Production (absolute path)
STATIC_DIR="/var/lib/keep/webapp"

# Docker (container path)
STATIC_DIR="/app/webapp/build"
```

#### LOG_LEVEL
**Purpose**: Application logging verbosity
**Default**: `info`
**Options**: `debug`, `info`, `warn`, `error`

```bash
# Development
LOG_LEVEL=debug

# Production
LOG_LEVEL=info

# Minimal logging
LOG_LEVEL=error
```

## Configuration Methods

### Method 1: Environment Variables

#### System Environment
```bash
# In shell
export JWT_SECRET="your-secret-here"
export DB_PATH="/var/lib/keep/keep.db"
export PORT=8080

# Run application
./keep
```

#### Systemd Service
```ini
# /etc/systemd/system/keep.service
[Service]
Environment="JWT_SECRET=your-secret-here"
Environment="DB_PATH=/var/lib/keep/keep.db"
Environment="PORT=8080"
ExecStart=/usr/local/bin/keep
```

### Method 2: Environment File

#### .env File
```bash
# /etc/keep/.env or project root/.env
JWT_SECRET=your-secret-here
DB_PATH=/var/lib/keep/keep.db
PORT=8080
STATIC_DIR=/var/lib/keep/webapp
LOG_LEVEL=info
```

#### Load Environment File
```bash
# Using systemd
[Service]
EnvironmentFile=/etc/keep/.env
ExecStart=/usr/local/bin/keep

# Using shell
set -a  # automatically export variables
source /etc/keep/.env
set +a
./keep
```

### Method 3: Docker Configuration

#### Docker Compose
```yaml
version: '3.8'
services:
  keep:
    image: keep:latest
    environment:
      - JWT_SECRET=${JWT_SECRET}
      - DB_PATH=/data/keep.db
      - PORT=8080
      - LOG_LEVEL=info
    env_file:
      - .env
```

#### Docker Command Line
```bash
docker run \
  -e JWT_SECRET="your-secret-here" \
  -e DB_PATH="/data/keep.db" \
  -e PORT=8080 \
  -p 8080:8080 \
  -v ./data:/data \
  keep:latest
```

## Security Configuration

### JWT Token Configuration

#### Token Expiration
Tokens currently expire after 24 hours (hardcoded). To modify:

1. Edit `server/internal/auth/auth.go`
2. Change the `ExpiresAt` value:

```go
// Change from 24 hours to desired duration
ExpiresAt: jwt.NewNumericDate(time.Now().Add(12 * time.Hour)), // 12 hours
```

#### Token Security Best Practices
- Use strong JWT secrets (32+ characters)
- Rotate JWT secrets periodically
- Monitor token usage in logs
- Consider shorter expiration for high-security environments

### Database Security

#### File Permissions
```bash
# Database file (read/write for app user only)
chmod 600 /var/lib/keep/keep.db
chown keep:keep /var/lib/keep/keep.db

# Database directory (read/execute for app user)
chmod 700 /var/lib/keep
chown keep:keep /var/lib/keep
```

#### SQLite Security Settings
The application uses prepared statements to prevent SQL injection. Additional SQLite security is handled automatically.

### Network Security

#### Firewall Configuration
```bash
# UFW (Ubuntu)
sudo ufw allow 8080/tcp
sudo ufw enable

# iptables
sudo iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
sudo iptables-save
```

#### Reverse Proxy Security Headers
```nginx
# Nginx security headers
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Robots-Tag "noindex, nofollow" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
```

## Performance Configuration

### Database Performance

#### SQLite Optimization
The application handles SQLite optimization automatically, but you can monitor performance:

```sql
-- Check database size
SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size();

-- Check table statistics
SELECT name, rootpage, sql FROM sqlite_master WHERE type='table';

-- Analyze database
ANALYZE;
```

#### Database Maintenance
```bash
#!/bin/bash
# Database maintenance script

DB_PATH="/var/lib/keep/keep.db"

# Vacuum database (reclaim space)
sqlite3 "$DB_PATH" "VACUUM;"

# Update statistics
sqlite3 "$DB_PATH" "ANALYZE;"

# Check integrity
sqlite3 "$DB_PATH" "PRAGMA integrity_check;"
```

### Application Performance

#### Memory Usage
Monitor application memory usage:

```bash
# Check memory usage
ps aux | grep keep
systemctl status keep

# Monitor with htop
htop -p $(pgrep keep)
```

#### Resource Limits
```ini
# /etc/systemd/system/keep.service
[Service]
# Limit memory usage to 512MB
MemoryLimit=512M

# Limit CPU usage to 50%
CPUQuota=50%

# Limit file descriptors
LimitNOFILE=1024
```

### Frontend Performance

#### Static File Serving
For high-traffic deployments, serve static files directly from Nginx:

```nginx
# Nginx configuration
location /static/ {
    alias /var/lib/keep/webapp/;
    
    # Cache static files
    expires 1y;
    add_header Cache-Control "public, immutable";
    
    # Gzip compression
    gzip on;
    gzip_types text/css application/javascript image/svg+xml;
}

# Proxy API requests to Keep
location /api/v1/ {
    proxy_pass http://localhost:8080;
    # ... other proxy settings
}

# Serve React app for all other requests
location / {
    try_files $uri $uri/ @keep;
}

location @keep {
    proxy_pass http://localhost:8080;
    # ... other proxy settings
}
```

## Monitoring Configuration

### Health Checks

#### HTTP Health Check
```bash
# Simple health check
curl -f http://localhost:8080/health || exit 1

# Detailed health check script
#!/bin/bash
HEALTH_URL="http://localhost:8080/health"
TIMEOUT=10

if ! curl -f -s --max-time $TIMEOUT "$HEALTH_URL" > /dev/null; then
    echo "Health check failed"
    exit 1
fi

echo "Health check passed"
```

#### Systemd Health Monitoring
```ini
# /etc/systemd/system/keep.service
[Service]
ExecStart=/usr/local/bin/keep
Restart=always
RestartSec=5

# Health check every 30 seconds
ExecStartPost=/bin/bash -c 'sleep 10 && curl -f http://localhost:8080/health'
```

### Logging Configuration

#### Structured Logging
Keep outputs structured logs to stdout/stderr. Configure log aggregation:

```bash
# Journal logs
journalctl -u keep -f --output=json

# File logging with systemd
[Service]
StandardOutput=append:/var/log/keep/keep.log
StandardError=append:/var/log/keep/keep.error.log
```

#### Log Rotation
```bash
# /etc/logrotate.d/keep
/var/log/keep/*.log {
    daily
    missingok
    rotate 30
    compress
    notifempty
    create 644 keep keep
    postrotate
        systemctl reload keep
    endscript
}
```

### Metrics and Alerting

#### Basic Monitoring Script
```bash
#!/bin/bash
# /usr/local/bin/keep-monitor.sh

# Configuration
LOG_FILE="/var/log/keep-monitor.log"
ALERT_EMAIL="admin@example.com"

# Check health endpoint
if ! curl -f -s http://localhost:8080/health > /dev/null; then
    echo "$(date): Health check failed" >> "$LOG_FILE"
    echo "Keep health check failed on $(hostname)" | mail -s "Keep Alert" "$ALERT_EMAIL"
    exit 1
fi

# Check database connectivity
if ! sqlite3 /var/lib/keep/keep.db "SELECT 1;" > /dev/null 2>&1; then
    echo "$(date): Database check failed" >> "$LOG_FILE"
    echo "Keep database check failed on $(hostname)" | mail -s "Keep Alert" "$ALERT_EMAIL"
    exit 1
fi

# Check disk space (warn if >80% full)
DISK_USAGE=$(df /var/lib/keep | awk 'NR==2 {print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -gt 80 ]; then
    echo "$(date): Disk usage high: ${DISK_USAGE}%" >> "$LOG_FILE"
    echo "Keep disk usage is ${DISK_USAGE}% on $(hostname)" | mail -s "Keep Warning" "$ALERT_EMAIL"
fi

echo "$(date): All checks passed" >> "$LOG_FILE"
```

## Backup Configuration

### Automated Backup Script
```bash
#!/bin/bash
# /usr/local/bin/keep-backup.sh

# Configuration
BACKUP_DIR="/backups/keep"
DB_PATH="/var/lib/keep/keep.db"
RETENTION_DAYS=30
LOG_FILE="/var/log/keep-backup.log"

# Logging function
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" >> "$LOG_FILE"
}

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Generate backup filename
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/keep_backup_$DATE.db"

# Perform backup
log "Starting backup to $BACKUP_FILE"
if sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"; then
    # Compress backup
    gzip "$BACKUP_FILE"
    log "Backup completed successfully: ${BACKUP_FILE}.gz"
    
    # Clean old backups
    find "$BACKUP_DIR" -name "keep_backup_*.db.gz" -mtime +$RETENTION_DAYS -delete
    log "Cleaned backups older than $RETENTION_DAYS days"
else
    log "Backup failed!"
    exit 1
fi
```

### Backup Schedule
```bash
# Crontab entry (crontab -e)
# Daily backup at 2:00 AM
0 2 * * * /usr/local/bin/keep-backup.sh

# Weekly backup verification
0 3 * * 0 /usr/local/bin/keep-verify-backup.sh
```

## Production Deployment Checklist

### Pre-Deployment
- [ ] Generate secure JWT_SECRET
- [ ] Set up proper file permissions
- [ ] Configure firewall rules
- [ ] Set up reverse proxy with HTTPS
- [ ] Configure automated backups
- [ ] Set up monitoring and alerting
- [ ] Test disaster recovery procedures

### Post-Deployment
- [ ] Verify health endpoint responds
- [ ] Test user registration and login
- [ ] Verify note creation and editing
- [ ] Check log files for errors
- [ ] Monitor system resources
- [ ] Test backup and restore procedures
- [ ] Update documentation with actual configuration

---

Keep your Keep instance secure and performant with proper configuration! 🔒