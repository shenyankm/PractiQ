import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import readline from 'node:readline';
import crypto from 'node:crypto';
import path from 'node:path';

const execAsync = promisify(exec);

function question(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

async function getPostgresURL(): Promise<string> {
  console.log('Step 1: Setting up Postgres');
  const dbChoice = await question(
    'Use local Postgres with Podman + Quadlet (L) or a remote Postgres instance (R)? (L/R): '
  );

  if (dbChoice.toLowerCase() === 'l') {
    console.log('Setting up local Postgres with Podman + Quadlet...');
    await setupLocalPostgres();
    return 'postgres://openwook:openwook@localhost:54322/openwook';
  } else {
    console.log(
      'You can find Postgres databases at: https://vercel.com/marketplace?category=databases'
    );
    return await question('Enter your POSTGRES_URL: ');
  }
}

async function setupLocalPostgres() {
  console.log('Checking if Podman is installed...');
  try {
    await execAsync('podman --version');
    await execAsync('systemctl --user --version');
  } catch {
    console.error('Podman and user systemd are required for the local database.');
    console.log('Install Podman, then retry or use a remote Postgres URL.');
    process.exit(1);
  }

  try {
    await execAsync('bash scripts/podman-db.sh up');
    console.log('Podman Quadlet Postgres started on localhost:54322.');
  } catch {
    console.error('Failed to start the Podman Quadlet Postgres container.');
    console.log('Run `./scripts/podman-db.sh status` for details.');
    process.exit(1);
  }
}

function generateAuthSecret(): string {
  console.log('Step 2: Generating AUTH_SECRET...');
  return crypto.randomBytes(32).toString('hex');
}

async function writeEnvFile(envVars: Record<string, string>) {
  console.log('Step 3: Writing environment variables to .env');
  const envContent = Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  await fs.writeFile(path.join(process.cwd(), '.env'), envContent);
  console.log('.env file created with the necessary variables.');
}

async function main() {
  const POSTGRES_URL = await getPostgresURL();
  const BASE_URL = 'http://localhost:3000';
  const AUTH_SECRET = generateAuthSecret();

  await writeEnvFile({
    DATABASE_URL: POSTGRES_URL,
    POSTGRES_URL,
    NEXT_PUBLIC_APP_URL: BASE_URL,
    AUTH_SECRET,
  });

  console.log('🎉 Setup completed successfully!');
}

main().catch(console.error);
