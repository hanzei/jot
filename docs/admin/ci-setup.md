# CI/CD Setup Guide

This guide covers setting up the continuous integration and deployment pipeline for Jot, including Docker Hub integration.

## GitHub Actions CI/CD

Jot uses GitHub Actions for automated testing, building, and publishing. CI is split into per-component workflows in `.github/workflows/`:

### Workflows

| Workflow | File | Triggers | Jobs |
|----------|------|----------|------|
| **Server — CI** | `server-ci.yml` | `server/**` push/PR | test, lint |
| **Webapp — CI** | `webapp-ci.yml` | `webapp/**` push/PR | test, lint, translations, e2e |
| **Mobile — CI** | `mobile-ci.yml` | `mobile/**` push/PR | lint, test |
| **Mobile — APK Build** | `mobile-apk.yml` | master push, `v*` tags | build-apk |
| **Docker** | `ci.yml` | master push, PR | docker, docker-merge |

Each component only triggers CI when its own files change.

### Docker Hub Integration

The CI pipeline automatically builds and publishes Docker images to Docker Hub when changes are pushed to the master branch.

#### Required GitHub Secrets

To enable Docker Hub publishing, add these secrets to your GitHub repository:

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Add the following repository secrets:

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `DOCKER_HUB_USERNAME` | Your Docker Hub username | Your Docker Hub account username |
| `DOCKER_HUB_TOKEN` | Docker Hub access token | Create at [Docker Hub Security](https://hub.docker.com/settings/security) |

#### Mobile APK Build Secrets

The mobile APK build workflow requires additional secrets:

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `GOOGLE_SERVICES_JSON` | Full contents of `google-services.json` | Firebase Console → Project Settings → Android app |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded release keystore | `base64 -w0 release.keystore` |
| `ANDROID_KEY_ALIAS` | Alias of the signing key | Set when generating keystore |
| `ANDROID_STORE_PASSWORD` | Keystore password | Set when generating keystore |
| `ANDROID_KEY_PASSWORD` | Key password | Set when generating keystore |

Generate a release keystore:
```bash
keytool -genkey -v -keystore release.keystore -alias jot \
  -keyalg RSA -keysize 2048 -validity 10000
```

Never commit the keystore or `google-services.json` to the repository.

#### Creating a Docker Hub Access Token

1. Log in to [Docker Hub](https://hub.docker.com)
2. Go to **Account Settings** → **Security**
3. Click **New Access Token**
4. Enter a description (e.g., "GitHub Actions CI")
5. Select **Public Repo Read/Write** permissions
6. Click **Generate**
7. Copy the token immediately (it won't be shown again)
8. Add it as `DOCKER_HUB_TOKEN` in your GitHub repository secrets

### Image Publishing Strategy

The CI pipeline publishes images with different tags:

- **`hanzei/jot:latest`** - Latest stable release (master branch only)
- **`hanzei/jot:pr-<number>`** - Pull request builds (for testing)
- **`hanzei/jot:master-<sha>`** - Specific commit builds from master
- **`hanzei/jot:<branch>-<sha>`** - Feature branch builds

### Multi-Platform Builds

Images are built for multiple architectures:
- `linux/amd64` (Intel/AMD processors)
- `linux/arm64` (ARM processors, Apple Silicon, Raspberry Pi)

### Build Caching

The CI pipeline uses GitHub Actions cache to speed up Docker builds by caching layers between builds.

## Local Development

### Running CI Checks Locally

Before pushing changes, you can run the same checks locally:

```bash
# Install Task runner (if not already installed)
go install github.com/go-task/task/v3/cmd/task@latest

# Run all tests
task test

# Run linting
task lint

# Run individual checks
task test-server
task test-webapp
task test-mobile
task lint-server
task lint-webapp
task lint-mobile
task check-translations
```

### Testing Docker Builds Locally

```bash
# Build the same multi-platform image locally
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t hanzei/jot:test \
  .

# Or build for current platform only
docker build -t hanzei/jot:test .
```

## Troubleshooting CI/CD

### Common Issues

#### Docker Hub Authentication Failed

**Error**: `denied: requested access to the resource is denied`

**Solution**: 
1. Verify `DOCKER_HUB_USERNAME` and `DOCKER_HUB_TOKEN` are correct
2. Ensure the Docker Hub token has **Public Repo Read/Write** permissions
3. Check that the token hasn't expired

#### Build Timeout

**Error**: `The job running on runner GitHub Actions X has exceeded the maximum execution time of 360 minutes.`

**Solution**: 
- Usually indicates a problem with dependency installation
- Check the build logs for hanging processes
- Consider reducing build parallelism

#### Platform Build Failures

**Error**: `failed to solve: no match for platform in manifest`

**Solution**:
- Some dependencies might not support all target platforms
- Check base images support both `linux/amd64` and `linux/arm64`
- Review Dockerfile for platform-specific commands

### Monitoring CI/CD

#### Build Status

- Check the **Actions** tab in your GitHub repository
- Green checkmark = successful build and publish
- Red X = failed build (check logs for details)

#### Docker Hub Status

- Visit [hanzei/jot on Docker Hub](https://hub.docker.com/r/hanzei/jot)
- Check **Tags** tab for published images
- Verify images are published with correct tags

### Manual Publishing

If you need to manually publish an image:

```bash
# Build and tag the image
docker build -t hanzei/jot:manual .

# Log in to Docker Hub
docker login

# Push the image
docker push hanzei/jot:manual
```

## Security Considerations

### Secrets Management

- Never commit Docker Hub credentials to the repository
- Use GitHub Secrets for sensitive information
- Rotate Docker Hub tokens regularly (every 6-12 months)
- Use minimal required permissions for tokens

### Image Security

- Images are built from trusted base images (Node.js Alpine, Go Alpine)
- Multi-stage builds minimize attack surface
- No secrets are embedded in images
- Regular dependency updates through Dependabot

---

Your CI/CD pipeline is now configured for automated Docker Hub publishing! 🚀