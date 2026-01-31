#!/usr/bin/env node

/**
 * OpenTTD WASM Build Script
 * Builds OpenTTD for WebAssembly using Emscripten SDK
 * No Docker required - uses local emsdk installation
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');
const WEB_DIR = join(__dirname, '..');
const BUILD_HOST_DIR = join(ROOT_DIR, 'build-host');
const BUILD_WASM_DIR = join(ROOT_DIR, 'build-wasm');
const DIST_DIR = join(WEB_DIR, 'src');

const IS_WINDOWS = platform() === 'win32';
const EMSDK_VERSION = '3.1.57';

// Common emsdk locations
const EMSDK_PATHS = IS_WINDOWS
  ? [
      join(homedir(), 'emsdk'),
      'C:\\emsdk',
      join(process.env.LOCALAPPDATA || '', 'emsdk'),
      join(ROOT_DIR, 'emsdk')
    ]
  : [
      join(homedir(), 'emsdk'),
      '/opt/emsdk',
      '/usr/local/emsdk',
      join(ROOT_DIR, 'emsdk')
    ];

let EMSDK_DIR = null;

/**
 * Execute a command and stream output
 */
function exec(command, options = {}) {
  console.log(`\n> ${command}\n`);
  try {
    execSync(command, {
      stdio: 'inherit',
      cwd: options.cwd || ROOT_DIR,
      shell: true,
      env: { ...process.env, ...options.env },
      ...options
    });
    return true;
  } catch (e) {
    if (options.ignoreError) return false;
    console.error(`Command failed: ${command}`);
    process.exit(1);
  }
}

/**
 * Execute and return output
 */
function execOutput(command, options = {}) {
  try {
    return execSync(command, {
      cwd: options.cwd || ROOT_DIR,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, ...options.env },
      ...options
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Find emsdk installation
 */
function findEmsdk() {
  // Check if emcc is already in PATH
  const emccPath = execOutput(IS_WINDOWS ? 'where emcc 2>nul' : 'which emcc 2>/dev/null');
  if (emccPath) {
    console.log(`Found emcc in PATH: ${emccPath}`);
    return 'PATH';
  }

  // Check common locations
  for (const path of EMSDK_PATHS) {
    const emsdkScript = IS_WINDOWS
      ? join(path, 'emsdk.bat')
      : join(path, 'emsdk');

    if (existsSync(emsdkScript)) {
      console.log(`Found emsdk at: ${path}`);
      return path;
    }
  }

  return null;
}

/**
 * Get emsdk environment variables
 */
function getEmsdkEnv() {
  if (EMSDK_DIR === 'PATH') {
    return process.env;
  }

  const envScript = IS_WINDOWS
    ? join(EMSDK_DIR, 'emsdk_env.bat')
    : join(EMSDK_DIR, 'emsdk_env.sh');

  if (!existsSync(envScript)) {
    console.error('emsdk_env script not found');
    return process.env;
  }

  // Get environment from emsdk
  let envOutput;
  if (IS_WINDOWS) {
    envOutput = execOutput(`"${envScript}" && set`, { cwd: EMSDK_DIR });
  } else {
    envOutput = execOutput(`source "${envScript}" && env`, { cwd: EMSDK_DIR });
  }

  if (!envOutput) return process.env;

  const env = { ...process.env };
  for (const line of envOutput.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.substring(0, idx);
      const value = line.substring(idx + 1);
      env[key] = value;
    }
  }

  return env;
}

/**
 * Install emsdk
 */
async function installEmsdk() {
  const installDir = join(ROOT_DIR, 'emsdk');

  console.log('\n=== Installing Emscripten SDK ===\n');
  console.log(`Installing to: ${installDir}`);

  if (!existsSync(installDir)) {
    exec(`git clone https://github.com/emscripten-core/emsdk.git "${installDir}"`);
  }

  const emsdk = IS_WINDOWS ? 'emsdk.bat' : './emsdk';

  exec(`${emsdk} install ${EMSDK_VERSION}`, { cwd: installDir });
  exec(`${emsdk} activate ${EMSDK_VERSION}`, { cwd: installDir });

  return installDir;
}

/**
 * Build host tools (needed for cross-compilation)
 */
function buildHostTools(env) {
  console.log('\n=== Building Host Tools ===\n');

  if (!existsSync(BUILD_HOST_DIR)) {
    mkdirSync(BUILD_HOST_DIR, { recursive: true });
  }

  // Check if already built
  const toolsExist = IS_WINDOWS
    ? existsSync(join(BUILD_HOST_DIR, 'tools', 'strgen', 'strgen.exe'))
    : existsSync(join(BUILD_HOST_DIR, 'tools', 'strgen', 'strgen'));

  if (toolsExist) {
    console.log('Host tools already built, skipping...');
    return;
  }

  exec('cmake .. -DOPTION_TOOLS_ONLY=ON', { cwd: BUILD_HOST_DIR });

  const buildCmd = IS_WINDOWS
    ? 'cmake --build . --target tools --config Release'
    : 'make -j4 tools';

  exec(buildCmd, { cwd: BUILD_HOST_DIR });
}

/**
 * Build WASM module
 */
function buildWasm(env) {
  console.log('\n=== Building WASM Module ===\n');

  if (!existsSync(BUILD_WASM_DIR)) {
    mkdirSync(BUILD_WASM_DIR, { recursive: true });
  }

  const hostBinaryDir = BUILD_HOST_DIR.replace(/\\/g, '/');

  // Configure with emcmake
  const cmakeCmd = [
    'emcmake cmake ..',
    `-DHOST_BINARY_DIR="${hostBinaryDir}"`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DOPTION_USE_ASSERTS=OFF'
  ].join(' ');

  exec(cmakeCmd, { cwd: BUILD_WASM_DIR, env });

  // Build with emmake
  const buildCmd = IS_WINDOWS
    ? 'emmake cmake --build . --config Release'
    : 'emmake make -j4';

  exec(buildCmd, { cwd: BUILD_WASM_DIR, env });
}

/**
 * Copy build artifacts to web directory
 */
function copyArtifacts() {
  console.log('\n=== Copying Build Artifacts ===\n');

  const artifacts = [
    'openttd.js',
    'openttd.wasm',
    'openttd.data'
  ];

  let copied = 0;

  for (const file of artifacts) {
    const src = join(BUILD_WASM_DIR, file);
    const dest = join(DIST_DIR, file);

    if (existsSync(src)) {
      console.log(`Copying ${file}...`);
      copyFileSync(src, dest);
      copied++;
    } else {
      console.warn(`Warning: ${file} not found`);
    }
  }

  // Also copy any additional .data files
  if (existsSync(BUILD_WASM_DIR)) {
    const dataFiles = readdirSync(BUILD_WASM_DIR).filter(f =>
      f.endsWith('.data') && !artifacts.includes(f)
    );
    for (const file of dataFiles) {
      const src = join(BUILD_WASM_DIR, file);
      const dest = join(DIST_DIR, file);
      console.log(`Copying ${file}...`);
      copyFileSync(src, dest);
      copied++;
    }
  }

  if (copied > 0) {
    console.log(`\n${copied} file(s) copied to web/src/`);
  } else {
    console.error('\nNo artifacts found! Build may have failed.');
    process.exit(1);
  }
}

/**
 * Print installation instructions
 */
function printInstallInstructions() {
  console.log('\n=== Emscripten SDK Not Found ===\n');
  console.log('To install Emscripten SDK:\n');

  if (IS_WINDOWS) {
    console.log('Option 1: Let this script install it');
    console.log('  node scripts/build-wasm.js --install\n');
    console.log('Option 2: Manual installation');
    console.log('  git clone https://github.com/emscripten-core/emsdk.git C:\\emsdk');
    console.log('  cd C:\\emsdk');
    console.log(`  emsdk install ${EMSDK_VERSION}`);
    console.log(`  emsdk activate ${EMSDK_VERSION}`);
    console.log('  emsdk_env.bat');
  } else {
    console.log('Option 1: Let this script install it');
    console.log('  node scripts/build-wasm.js --install\n');
    console.log('Option 2: Manual installation');
    console.log('  git clone https://github.com/emscripten-core/emsdk.git ~/emsdk');
    console.log('  cd ~/emsdk');
    console.log(`  ./emsdk install ${EMSDK_VERSION}`);
    console.log(`  ./emsdk activate ${EMSDK_VERSION}`);
    console.log('  source ./emsdk_env.sh');
  }

  console.log('\nThen run this script again:');
  console.log('  npm run build:wasm');
}

/**
 * Main build process
 */
async function main() {
  const args = process.argv.slice(2);

  console.log('=================================');
  console.log('  OpenTTD WASM Build Script');
  console.log(`  Platform: ${platform()}`);
  console.log('=================================\n');

  // Handle --help
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/build-wasm.js [options]\n');
    console.log('Options:');
    console.log('  --help, -h     Show this help');
    console.log('  --install      Install Emscripten SDK if not found');
    console.log('  --clean        Clean build directories before building');
    console.log('  --skip-host    Skip building host tools (if already built)');
    process.exit(0);
  }

  // Handle --clean
  if (args.includes('--clean')) {
    console.log('Cleaning build directories...');
    if (existsSync(BUILD_HOST_DIR)) {
      exec(IS_WINDOWS ? `rmdir /s /q "${BUILD_HOST_DIR}"` : `rm -rf "${BUILD_HOST_DIR}"`, { ignoreError: true });
    }
    if (existsSync(BUILD_WASM_DIR)) {
      exec(IS_WINDOWS ? `rmdir /s /q "${BUILD_WASM_DIR}"` : `rm -rf "${BUILD_WASM_DIR}"`, { ignoreError: true });
    }
  }

  // Find or install emsdk
  EMSDK_DIR = findEmsdk();

  if (!EMSDK_DIR) {
    if (args.includes('--install')) {
      EMSDK_DIR = await installEmsdk();
    } else {
      printInstallInstructions();
      process.exit(1);
    }
  }

  // Get emsdk environment
  const env = getEmsdkEnv();

  // Verify emcc works
  const emccVersion = execOutput('emcc --version', { env });
  if (!emccVersion) {
    console.error('Error: emcc not working. Try running emsdk_env first.');
    process.exit(1);
  }
  console.log(`Emscripten: ${emccVersion.split('\n')[0]}`);

  // Build host tools
  if (!args.includes('--skip-host')) {
    buildHostTools(env);
  }

  // Build WASM
  buildWasm(env);

  // Copy artifacts
  copyArtifacts();

  console.log('\n=================================');
  console.log('  Build Complete!');
  console.log('=================================');
  console.log('\nTo run the game:');
  console.log('  cd web');
  console.log('  npm run dev');
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
