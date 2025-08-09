# Jot Maintenance Guide

This guide covers ongoing maintenance tasks for Jot administrators, including monitoring, backups, updates, and troubleshooting.

## Regular Maintenance Tasks

### Daily Tasks

#### Health Monitoring
```bash
# Check application health
curl -f http://localhost:8080/health

# Check service status
sudo systemctl status jot

# Monitor resource usage
ps aux | grep jot
df -h /var/lib/jot
```

#### Log Review
```bash
# Check for errors in recent logs
sudo journalctl -u jot --since "24 hours ago" | grep -i error

# Monitor log growth
ls -lh /var/log/jot/
```

### Weekly Tasks

#### Database Maintenance
```bash
# Check database integrity
sqlite3 /var/lib/jot/jot.db "PRAGMA integrity_check;"

# Update database statistics
sqlite3 /var/lib/jot/jot.db "ANALYZE;"

# Check database size
sqlite3 /var/lib/jot/jot.db "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size();"
```

#### Backup Verification
```bash
# Verify recent backups exist
ls -la /backups/jot/ | head -10

# Test backup restoration (in safe environment)
./test-backup-restore.sh
```

### Monthly Tasks

#### Security Review
```bash
# Review user accounts (check for suspicious activity)
sqlite3 /var/lib/jot/jot.db "SELECT id, email, created_at, is_admin FROM users ORDER BY created_at DESC;"

# Check file permissions
ls -la /var/lib/jot/
ls -la /etc/jot/

# Review firewall rules
sudo ufw status verbose
```

#### Performance Analysis
```bash
# Analyze database performance
sqlite3 /var/lib/jot/jot.db ".stats on" ".schema"

# Check system resource trends
sar -u 1 3  # CPU usage
free -h     # Memory usage
iostat 1 3  # I/O statistics
```

#### Updates and Patching
```bash
# Check for Jot updates
# (Manual process - check GitHub releases)

# Update system packages
sudo apt update && sudo apt upgrade

# Update Docker images (if using Docker)
docker-compose pull
docker-compose up -d
```

## Backup Management

### Backup Strategy

#### Automated Daily Backups
```bash
#!/bin/bash
# /usr/local/bin/jot-backup.sh

set -e  # Exit on any error

# Configuration
BACKUP_DIR="/backups/jot"
DB_PATH="/var/lib/jot/jot.db"
RETENTION_DAYS=30
LOG_FILE="/var/log/jot-backup.log"
ALERT_EMAIL="admin@example.com"

# Logging function
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" | tee -a "$LOG_FILE"
}

# Error handling
error_exit() {
    log "ERROR: $1"
    echo "Jot backup failed on $(hostname): $1" | mail -s "Backup Failed" "$ALERT_EMAIL"
    exit 1
}

# Pre-backup checks
log "Starting backup process"

# Check if Jot is running
if ! systemctl is-active --quiet jot; then
    error_exit "Jot service is not running"
fi

# Check database file exists and is readable
if [[ ! -f "$DB_PATH" ]]; then
    error_exit "Database file not found: $DB_PATH"
fi

# Check available disk space (need at least 100MB)
AVAILABLE_SPACE=$(df "$BACKUP_DIR" | awk 'NR==2 {print $4}')
if [[ $AVAILABLE_SPACE -lt 100000 ]]; then
    error_exit "Insufficient disk space for backup"
fi

# Create backup directory
mkdir -p "$BACKUP_DIR" || error_exit "Failed to create backup directory"

# Generate backup filename with timestamp
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/jot_backup_$DATE.db"

# Perform database backup
log "Creating backup: $BACKUP_FILE"
if ! sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"; then
    error_exit "Database backup failed"
fi

# Verify backup integrity
log "Verifying backup integrity"
if ! sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" | grep -q "ok"; then
    rm -f "$BACKUP_FILE"
    error_exit "Backup integrity check failed"
fi

# Compress backup to save space
log "Compressing backup"
if ! gzip "$BACKUP_FILE"; then
    error_exit "Backup compression failed"
fi

COMPRESSED_BACKUP="${BACKUP_FILE}.gz"
BACKUP_SIZE=$(stat -c%s "$COMPRESSED_BACKUP" | numfmt --to=iec)
log "Backup completed successfully: $(basename "$COMPRESSED_BACKUP") ($BACKUP_SIZE)"

# Clean up old backups
log "Cleaning up old backups (older than $RETENTION_DAYS days)"
OLD_BACKUPS=$(find "$BACKUP_DIR" -name "jot_backup_*.db.gz" -mtime +$RETENTION_DAYS)
if [[ -n "$OLD_BACKUPS" ]]; then
    echo "$OLD_BACKUPS" | xargs rm -f
    log "Removed old backups: $(echo "$OLD_BACKUPS" | wc -l) files"
else
    log "No old backups to remove"
fi

# Backup statistics
TOTAL_BACKUPS=$(ls "$BACKUP_DIR"/jot_backup_*.db.gz 2>/dev/null | wc -l)
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
log "Backup completed. Total backups: $TOTAL_BACKUPS, Total size: $TOTAL_SIZE"
```

#### Cron Schedule
```bash
# Add to root crontab: sudo crontab -e
# Daily backup at 2:00 AM
0 2 * * * /usr/local/bin/jot-backup.sh

# Weekly backup verification at 2:30 AM on Sundays
30 2 * * 0 /usr/local/bin/jot-verify-backup.sh

# Monthly cleanup of very old backups at 3:00 AM on 1st
0 3 1 * * find /backups/jot -name "jot_backup_*.db.gz" -mtime +90 -delete
```

### Backup Verification Script
```bash
#!/bin/bash
# /usr/local/bin/jot-verify-backup.sh

set -e

BACKUP_DIR="/backups/jot"
TEST_DIR="/tmp/jot-backup-test"
LOG_FILE="/var/log/jot-backup.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" | tee -a "$LOG_FILE"
}

log "Starting backup verification"

# Find most recent backup
LATEST_BACKUP=$(ls -1t "$BACKUP_DIR"/jot_backup_*.db.gz 2>/dev/null | head -1)

if [[ -z "$LATEST_BACKUP" ]]; then
    log "ERROR: No backup files found"
    exit 1
fi

log "Verifying backup: $(basename "$LATEST_BACKUP")"

# Create test directory
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Extract backup
gunzip -c "$LATEST_BACKUP" > test_restore.db

# Verify database integrity
if sqlite3 test_restore.db "PRAGMA integrity_check;" | grep -q "ok"; then
    log "Backup integrity verified successfully"
else
    log "ERROR: Backup integrity check failed"
    rm -rf "$TEST_DIR"
    exit 1
fi

# Test basic queries
USER_COUNT=$(sqlite3 test_restore.db "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
NOTE_COUNT=$(sqlite3 test_restore.db "SELECT COUNT(*) FROM notes;" 2>/dev/null || echo "0")

log "Backup contains $USER_COUNT users and $NOTE_COUNT notes"

# Cleanup
rm -rf "$TEST_DIR"
log "Backup verification completed successfully"
```

### Disaster Recovery

#### Full System Restore
```bash
#!/bin/bash
# /usr/local/bin/jot-restore.sh

set -e

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <backup-file.db.gz>"
    exit 1
fi

BACKUP_FILE="$1"
DB_PATH="/var/lib/jot/jot.db"
BACKUP_CURRENT="/tmp/jot_current_backup.db"

# Verify backup file exists
if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "Error: Backup file not found: $BACKUP_FILE"
    exit 1
fi

echo "WARNING: This will restore Jot from backup and replace all current data."
echo "Current database will be backed up to: $BACKUP_CURRENT"
echo "Backup file: $BACKUP_FILE"
read -p "Are you sure you want to continue? (yes/no): " confirm

if [[ "$confirm" != "yes" ]]; then
    echo "Restore cancelled"
    exit 0
fi

# Stop Jot service
echo "Stopping Jot service..."
sudo systemctl stop jot

# Backup current database
echo "Backing up current database..."
if [[ -f "$DB_PATH" ]]; then
    cp "$DB_PATH" "$BACKUP_CURRENT"
    echo "Current database backed up to: $BACKUP_CURRENT"
fi

# Restore from backup
echo "Restoring from backup..."
gunzip -c "$BACKUP_FILE" > "$DB_PATH"

# Set correct permissions
chown jot:jot "$DB_PATH"
chmod 600 "$DB_PATH"

# Verify restored database
echo "Verifying restored database..."
if sqlite3 "$DB_PATH" "PRAGMA integrity_check;" | grep -q "ok"; then
    echo "Database integrity verified"
else
    echo "Error: Restored database failed integrity check"
    echo "Restoring original database..."
    cp "$BACKUP_CURRENT" "$DB_PATH"
    exit 1
fi

# Start Jot service
echo "Starting Jot service..."
sudo systemctl start jot

# Wait for service to start
sleep 5

# Verify service is running
if systemctl is-active --quiet jot; then
    echo "Jot service started successfully"
    echo "Checking health endpoint..."
    if curl -f http://localhost:8080/health > /dev/null 2>&1; then
        echo "Restore completed successfully!"
        echo "Users can now access Jot normally"
    else
        echo "Warning: Service started but health check failed"
    fi
else
    echo "Error: Jot service failed to start"
    echo "Check logs with: sudo journalctl -u jot -f"
    exit 1
fi
```

## Monitoring and Alerting

### System Monitoring Script
```bash
#!/bin/bash
# /usr/local/bin/jot-monitor.sh

set -e

# Configuration
CONFIG_FILE="/etc/jot/monitor.conf"
LOG_FILE="/var/log/jot-monitor.log"
STATE_FILE="/var/lib/jot/monitor.state"

# Default thresholds (can be overridden in config file)
CPU_THRESHOLD=80
MEMORY_THRESHOLD=80
DISK_THRESHOLD=85
RESPONSE_TIMEOUT=10
ALERT_EMAIL="admin@example.com"

# Load configuration if exists
[[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE"

# Logging function
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" | tee -a "$LOG_FILE"
}

# Alert function
alert() {
    local subject="$1"
    local message="$2"
    local severity="${3:-WARNING}"
    
    log "$severity: $message"
    echo "$message" | mail -s "Jot $severity: $subject" "$ALERT_EMAIL"
    
    # Update state file to prevent spam
    echo "$(date +%s):$subject" >> "$STATE_FILE"
}

# Check if we already alerted recently (within 1 hour)
recently_alerted() {
    local subject="$1"
    local cutoff=$(($(date +%s) - 3600))
    
    [[ -f "$STATE_FILE" ]] && grep -q ":$subject$" "$STATE_FILE" && \
    [[ $(grep ":$subject$" "$STATE_FILE" | tail -1 | cut -d: -f1) -gt $cutoff ]]
}

# Health check
check_health() {
    log "Checking Jot health endpoint"
    if ! curl -f -s --max-time "$RESPONSE_TIMEOUT" http://localhost:8080/health > /dev/null; then
        if ! recently_alerted "health_check"; then
            alert "Health Check Failed" "Jot health endpoint is not responding"
        fi
        return 1
    fi
    log "Health check passed"
    return 0
}

# Service check
check_service() {
    log "Checking Jot service status"
    if ! systemctl is-active --quiet jot; then
        if ! recently_alerted "service_down"; then
            alert "Service Down" "Jot systemd service is not running"
        fi
        return 1
    fi
    log "Service check passed"
    return 0
}

# Database check
check_database() {
    log "Checking database connectivity"
    if ! sqlite3 /var/lib/jot/jot.db "SELECT 1;" > /dev/null 2>&1; then
        if ! recently_alerted "database_error"; then
            alert "Database Error" "Cannot connect to Jot database"
        fi
        return 1
    fi
    log "Database check passed"
    return 0
}

# CPU usage check
check_cpu() {
    local cpu_usage=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
    cpu_usage=${cpu_usage%.*}  # Remove decimal part
    
    log "CPU usage: ${cpu_usage}%"
    if [[ $cpu_usage -gt $CPU_THRESHOLD ]]; then
        if ! recently_alerted "high_cpu"; then
            alert "High CPU Usage" "CPU usage is ${cpu_usage}% (threshold: ${CPU_THRESHOLD}%)"
        fi
        return 1
    fi
    return 0
}

# Memory usage check
check_memory() {
    local memory_usage=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
    
    log "Memory usage: ${memory_usage}%"
    if [[ $memory_usage -gt $MEMORY_THRESHOLD ]]; then
        if ! recently_alerted "high_memory"; then
            alert "High Memory Usage" "Memory usage is ${memory_usage}% (threshold: ${MEMORY_THRESHOLD}%)"
        fi
        return 1
    fi
    return 0
}

# Disk usage check
check_disk() {
    local disk_usage=$(df /var/lib/jot | awk 'NR==2 {print $5}' | sed 's/%//')
    
    log "Disk usage: ${disk_usage}%"
    if [[ $disk_usage -gt $DISK_THRESHOLD ]]; then
        if ! recently_alerted "high_disk"; then
            alert "High Disk Usage" "Disk usage is ${disk_usage}% (threshold: ${DISK_THRESHOLD}%)"
        fi
        return 1
    fi
    return 0
}

# Certificate check (if using HTTPS)
check_certificate() {
    local domain="${KEEP_DOMAIN:-localhost}"
    local port="${KEEP_PORT:-443}"
    
    if [[ "$domain" != "localhost" ]]; then
        log "Checking SSL certificate for $domain"
        local expiry=$(echo | openssl s_client -servername "$domain" -connect "$domain:$port" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
        
        if [[ -n "$expiry" ]]; then
            local expiry_epoch=$(date -d "$expiry" +%s)
            local current_epoch=$(date +%s)
            local days_left=$(( (expiry_epoch - current_epoch) / 86400 ))
            
            log "SSL certificate expires in $days_left days"
            if [[ $days_left -lt 30 ]]; then
                if ! recently_alerted "cert_expiry"; then
                    alert "Certificate Expiring" "SSL certificate for $domain expires in $days_left days"
                fi
            fi
        fi
    fi
}

# Main monitoring logic
main() {
    log "Starting Jot monitoring checks"
    
    local failed_checks=0
    
    check_service || ((failed_checks++))
    check_health || ((failed_checks++))
    check_database || ((failed_checks++))
    check_cpu || ((failed_checks++))
    check_memory || ((failed_checks++))
    check_disk || ((failed_checks++))
    check_certificate || ((failed_checks++))
    
    # Clean old state entries (older than 24 hours)
    if [[ -f "$STATE_FILE" ]]; then
        local cutoff=$(($(date +%s) - 86400))
        awk -F: -v cutoff="$cutoff" '$1 > cutoff' "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
    fi
    
    if [[ $failed_checks -eq 0 ]]; then
        log "All monitoring checks passed"
        exit 0
    else
        log "Monitoring completed with $failed_checks failed checks"
        exit 1
    fi
}

# Run monitoring
main "$@"
```

### Monitoring Configuration
```bash
# /etc/jot/monitor.conf
CPU_THRESHOLD=75
MEMORY_THRESHOLD=80
DISK_THRESHOLD=90
RESPONSE_TIMEOUT=15
ALERT_EMAIL="admin@yourdomain.com"
KEEP_DOMAIN="jot.yourdomain.com"
KEEP_PORT=443
```

### Monitoring Cron Schedule
```bash
# Add to crontab
# Every 5 minutes during business hours (9 AM to 6 PM, Mon-Fri)
*/5 9-18 * * 1-5 /usr/local/bin/jot-monitor.sh

# Every hour outside business hours
0 * * * * /usr/local/bin/jot-monitor.sh

# Daily comprehensive check at 6 AM
0 6 * * * /usr/local/bin/jot-monitor.sh --comprehensive
```

## Performance Optimization

### Database Optimization
```bash
#!/bin/bash
# /usr/local/bin/jot-optimize-db.sh

set -e

DB_PATH="/var/lib/jot/jot.db"
LOG_FILE="/var/log/jot-maintenance.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" | tee -a "$LOG_FILE"
}

log "Starting database optimization"

# Check database before optimization
BEFORE_SIZE=$(stat -c%s "$DB_PATH")
log "Database size before optimization: $(numfmt --to=iec $BEFORE_SIZE)"

# Stop Jot service for maintenance
log "Stopping Jot service"
systemctl stop jot

# Backup database before optimization
BACKUP_FILE="/tmp/jot_pre_optimize_$(date +%Y%m%d_%H%M%S).db"
cp "$DB_PATH" "$BACKUP_FILE"
log "Created backup: $BACKUP_FILE"

# Run VACUUM to reclaim space
log "Running VACUUM to reclaim unused space"
sqlite3 "$DB_PATH" "VACUUM;"

# Update database statistics
log "Updating database statistics"
sqlite3 "$DB_PATH" "ANALYZE;"

# Verify database integrity
log "Verifying database integrity"
if sqlite3 "$DB_PATH" "PRAGMA integrity_check;" | grep -q "ok"; then
    log "Database integrity verified"
else
    log "ERROR: Database integrity check failed, restoring backup"
    cp "$BACKUP_FILE" "$DB_PATH"
    systemctl start jot
    exit 1
fi

# Check database after optimization
AFTER_SIZE=$(stat -c%s "$DB_PATH")
SAVED_SPACE=$((BEFORE_SIZE - AFTER_SIZE))
log "Database size after optimization: $(numfmt --to=iec $AFTER_SIZE)"
log "Space reclaimed: $(numfmt --to=iec $SAVED_SPACE)"

# Start Jot service
log "Starting Jot service"
systemctl start jot

# Wait for service to start and verify
sleep 5
if curl -f http://localhost:8080/health > /dev/null 2>&1; then
    log "Database optimization completed successfully"
    rm -f "$BACKUP_FILE"  # Remove temporary backup
else
    log "ERROR: Jot service failed to start after optimization"
    exit 1
fi
```

### Log Rotation and Cleanup
```bash
# /etc/logrotate.d/jot
/var/log/jot/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 jot jot
    postrotate
        # Signal Jot to reopen log files if needed
        systemctl reload-or-restart jot > /dev/null 2>&1 || true
    endscript
}

# Jot monitoring logs
/var/log/jot-monitor.log {
    weekly
    missingok
    rotate 12
    compress
    delaycompress
    notifempty
    create 644 root root
}

# Jot backup logs
/var/log/jot-backup.log {
    monthly
    missingok
    rotate 12
    compress
    delaycompress
    notifempty
    create 644 root root
}
```

## Troubleshooting Common Issues

### Service Won't Start
```bash
# Check service status
systemctl status jot

# Check logs for errors
journalctl -u jot --since "1 hour ago" | grep -i error

# Check configuration
sudo -u jot env | grep -E "(JWT_SECRET|DB_PATH|PORT)"

# Test database connectivity
sudo -u jot sqlite3 /var/lib/jot/jot.db "SELECT 1;"

# Check file permissions
ls -la /var/lib/jot/
```

### High Resource Usage
```bash
# Check what's consuming resources
top -p $(pgrep jot)
htop -p $(pgrep jot)

# Check database operations
sqlite3 /var/lib/jot/jot.db ".stats on"

# Analyze slow queries (if any)
# Enable query logging in SQLite if needed
```

### Connection Issues
```bash
# Check if port is open
netstat -tulpn | grep :8080
lsof -i :8080

# Test connectivity
curl -v http://localhost:8080/health

# Check firewall
ufw status
iptables -L | grep 8080
```

### Data Corruption
```bash
# Check database integrity
sqlite3 /var/lib/jot/jot.db "PRAGMA integrity_check;"

# Repair database if possible
sqlite3 /var/lib/jot/jot.db ".recover" | sqlite3 /var/lib/jot/jot_recovered.db

# Restore from backup if necessary
./jot-restore.sh /backups/jot/jot_backup_latest.db.gz
```

---

Regular maintenance ensures Jot runs smoothly and reliably! 🔧