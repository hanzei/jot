# Jot - Self-hosted Note-Taking Application

A self-hosted note-taking application built with Go backend and React frontend. The server serves both the API and the web application from a single port, making deployment and development simple.

## Features

- **User Authentication**: Email/password authentication with JWT tokens
- **Notes Management**: Create, edit, delete, and organize notes
- **Note Types**: Support for both plain text notes and todo lists with checkboxes
- **Search & Filter**: Find notes quickly with search and filtering capabilities
- **Responsive Design**: Works on desktop and mobile devices
- **Self-hosted**: Complete control over your data
- **SQLite Database**: Lightweight, file-based database
- **Admin Support**: First registered user becomes admin
- **Single Binary**: Frontend and backend served from one Go binary

## Development Setup

### Prerequisites

- **Go 1.24+**: [Download Go](https://golang.org/dl/)
- **Node.js 18+**: [Download Node.js](https://nodejs.org/)
- **npm**: Package manager for frontend dependencies

### Quick Start

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd jot
   ```

2. **Build and run** (recommended for most development):
   ```bash
   # Build the frontend
   cd webapp
   npm install
   npm run build
   cd ..
   
   # Start the server (serves both API and frontend)
   cd server
   go mod tidy
   go run main.go
   ```

### Task Automation

This project includes a [Taskfile](https://taskfile.dev/) for common development tasks:

```bash
# Install Task (if not already installed)
go install github.com/go-task/task/v3/cmd/task@latest

# Available commands
task run-server      # Start the Jot server
task run-webapp      # Build webapp in watch mode
task test            # Run all tests
task test-server     # Run server tests
task test-webapp     # Run webapp tests
task coverage        # Run server tests with coverage report
task lint            # Run linters
task lint-server     # Run server linting with golangci-lint
task lint-webapp     # Run webapp linting
```
   
3. **Access the application**:
   - Open `http://localhost:8080` in your browser
   - Register your first account (becomes admin automatically)
   - Start creating notes!

### Development Options

Access: `http://localhost:8080`

#### Development Build with Watch
For development builds that automatically rebuild when files change:

```bash
# Terminal 1: Watch and rebuild frontend automatically (unminified)
cd webapp && npm install && npm run build:watch

# Terminal 2: Run server with hot-reload
cd server && go run main.go
```

Access: `http://localhost:8080`

## Environment Variables

Configure the application using environment variables or `.env` file:

```bash
# Database configuration
DB_PATH=./jot.db                     # SQLite database file location
JWT_SECRET=your-secure-secret-key    # JWT signing key (change in production!)

# Server configuration  
PORT=8080                           # Server port (optional)
STATIC_DIR=../webapp/build/         # Frontend build directory (optional)
```

## API Endpoints

All API endpoints are prefixed with `/api/v1/`:

### Authentication
- `POST /api/v1/register` - Register new user
- `POST /api/v1/login` - Login user and receive JWT token

### Notes (Requires Authentication)
- `GET /api/v1/notes` - List user's notes
  - Query params: `archived=true/false`, `search=query`
- `POST /api/v1/notes` - Create new note
- `GET /api/v1/notes/{id}` - Get specific note
- `PUT /api/v1/notes/{id}` - Update note (title, content, pin, archive, color)
- `DELETE /api/v1/notes/{id}` - Delete note

### System
- `GET /health` - Server health check

### Example API Usage

```bash
# Register user
curl -X POST http://localhost:8080/api/v1/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'

# Create note (with token)
curl -X POST http://localhost:8080/api/v1/notes \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"My Note","content":"Note content","note_type":"text"}'
```

## Building for Production

### Single Binary Deployment (Recommended)

Build everything into one executable:

```bash
# 1. Build frontend (production build)
cd webapp
npm install
npm run build
cd ..

# Alternative: Development build (unminified, with source maps)
# npm run build:dev

# 2. Build backend (includes frontend files)
cd server
go build -o jot main.go

# 3. Deploy single binary
./jot
```

The binary will serve both API and frontend from port 8080.

### Environment Setup

Create `.env` file for production:

```bash
# Production environment
DB_PATH=/var/lib/jot/jot.db
JWT_SECRET=your-very-secure-random-secret-key-here
PORT=8080
```

## Docker Deployment

### Using Published Image (Recommended)

```bash
# Pull and run the latest image from Docker Hub
docker run -d \
  --name jot \
  -p 8080:8080 \
  -v ./data:/data \
  -e JWT_SECRET=$(openssl rand -base64 32) \
  hanzei/jot:latest

# Or use docker-compose
curl -O https://raw.githubusercontent.com/hanzei/jot/master/docker-compose.yml
echo "JWT_SECRET=$(openssl rand -base64 32)" > .env
docker-compose up -d
```

### Building from Source

```bash
# Build and run with docker-compose
docker-compose up -d

# Or build manually
docker build -t jot .
docker run -p 8080:8080 -v ./data:/data -e JWT_SECRET=your-secret jot
```

The Docker image uses multi-stage build:
1. **Node.js stage**: Builds the React frontend
2. **Go stage**: Builds the backend binary
3. **Alpine stage**: Combines everything in minimal production image

### Available Tags

- `hanzei/jot:latest` - Latest stable release (master branch)
- `hanzei/jot:pr-<number>` - Pull request builds
- `hanzei/jot:<branch>-<sha>` - Specific commit builds

### Custom Configuration

```yaml
# docker-compose.override.yml
version: '3.8'
services:
  jot:
    image: hanzei/jot:latest
    environment:
      - JWT_SECRET=your-production-secret
      - DB_PATH=/data/production.db
    volumes:
      - ./custom-data:/data
    ports:
      - "80:8080"  # Expose on port 80
```

## Troubleshooting

### Common Issues

1. **Frontend not loading**:
   ```bash
   # Check if frontend is built
   ls webapp/build/
   
   # Rebuild frontend
   cd webapp && npm run build
   ```

2. **Database permissions**:
   ```bash
   # Fix SQLite file permissions
   chmod 644 jot.db
   chown app:app jot.db
   ```

3. **Port conflicts**:
   ```bash
   # Use different port
   PORT=9000 go run main.go
   ```

4. **Migration errors**:
   ```bash
   # Reset database (WARNING: deletes all data)
   rm jot.db
   ```

5. **Build errors**:
   ```bash
   # Clean and rebuild
   cd webapp && rm -rf node_modules dist build && npm install && npm run build
   cd ../server && go clean && go mod tidy
   ```

### Development Tips

- **Frontend changes**: Rebuild with `npm run build` after React changes
- **Backend changes**: Go has hot-reload when using `go run`
- **Database inspection**: Use SQLite browser or `sqlite3 jot.db`
- **Logs**: Check console output for detailed error messages
- **API testing**: Use browser dev tools or curl/Postman

### Debugging

```bash
# Enable Go module debugging
GOMODULE=on go run main.go

# Frontend development build (separate dev server)
cd webapp && npm run dev

# Or development build with file watching (integrated with backend)
cd webapp && npm run build:watch

# Check database contents
sqlite3 jot.db "SELECT * FROM users;"
```

## Contributing

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/yourusername/jot.git`
3. **Create** feature branch: `git checkout -b feature/amazing-feature`
4. **Make** your changes following the existing code style
5. **Test** your changes thoroughly
6. **Commit** your changes: `git commit -m 'Add amazing feature'`
7. **Push** to branch: `git push origin feature/amazing-feature`
8. **Submit** a pull request

### Development Guidelines

- Follow Go and React best practices
- Add tests for new functionality
- Update documentation for API changes
- Ensure Docker build passes
- Test both development modes

### CI/CD Pipeline

Jot uses GitHub Actions for automated testing and Docker image publishing:

- **Automated testing**: All PRs trigger test and lint jobs
- **Docker publishing**: Master branch builds are published to `hanzei/jot` on Docker Hub
- **Multi-platform**: Images support both AMD64 and ARM64 architectures

For setup instructions, see [CI/CD Setup Guide](docs/admin/ci-setup.md).

## License

[Add your license here - e.g., MIT, GPL-3.0, etc.]

---

**Jot** - Simple, fast, and secure note-taking for everyone. 🚀