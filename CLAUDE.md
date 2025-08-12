# Jot Project Instructions

- When development instructions change (build scripts, dev setup, etc.), update the README.md to reflect the changes
- When functionality changes (API endpoints, features, configuration options, etc.), update the documentation in docs/ directory:
  - docs/user/ - Update user-facing documentation for new features or workflow changes
  - docs/admin/ - Update admin documentation for configuration, installation, or maintenance changes

## Development Tasks

Use the following Task commands for development:

- `task run-server` - Start the Jot server
- `task run-webapp` - Build webapp in watch mode
- `task test` - Run all tests
- `task test-server` - Run server tests
- `task test-webapp` - Run webapp tests
- `task coverage` - Run server tests with coverage report
- `task lint` - Run linters
- `task lint-server` - Run server linting with golangci-lint
- `task lint-webapp` - Run webapp linting

- Don't commit to master unless I specically ask you to do some. Use a seperate feature branch instead.


- Before creating a PR, run all tests and ensure they pass. Also run the linter.
- Don't create commits on the master branch unless I specifically ask you to do so.