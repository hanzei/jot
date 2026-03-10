import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  // Build the webapp so the Go server has fresh static files to serve.
  // The DB is created fresh by the Go server on startup (unique path per run).
  const webappDir = path.resolve(__dirname, '..');
  console.log('Building webapp for e2e tests...');
  execSync('npm run build', { cwd: webappDir, stdio: 'inherit' });
  console.log('Webapp build complete.');
}
