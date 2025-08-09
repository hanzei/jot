# Keep Project Instructions

- When development instructions change (build scripts, dev setup, etc.), update the README.md to reflect the changes
- When functionality changes (API endpoints, features, configuration options, etc.), update the documentation in docs/ directory:
  - docs/user/ - Update user-facing documentation for new features or workflow changes
  - docs/admin/ - Update admin documentation for configuration, installation, or maintenance changes

## Development Tasks

Use the following Task commands for development:

- `task run-server` - Start the Keep server
- `task run-webapp` - Start the webapp development server  
- `task webapp-watch` - Build webapp in watch mode
- `task test` - Run all tests
- `task test-server` - Run server tests
- `task coverage` - Run server tests with coverage report
