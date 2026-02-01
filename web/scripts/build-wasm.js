#!/usr/bin/env node

/**
 * OpenTTD WASM Build Script
 * Builds OpenTTD for WebAssembly using Emscripten SDK
 * No Docker required - uses local emsdk installation
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');
const WEB_DIR = join(__dirname, '..');
const BUILD_HOST_DIR = join(ROOT_DIR, 'build-host');
const BUILD_WASM_DIR = join(ROOT_DIR, 'build-wasm');
const DIST_DIR = join(WEB_DIR, 'static');

const IS_WINDOWS = platform() === 'win32';
const EMSDK_VERSION = '3.1.57';

// Force version to match official OpenTTD releases for multiplayer compatibility
// Format: version, isodate, modified, hash, istag, isstabletag
const FORCE_VERSION = '15.1';
const FORCE_VERSION_DATE = '20250108';
const FORCE_VERSION_HASH = '119d71ae952bbf03f9d07f0c3bcfa9bee7e38234';

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
    const mergedEnv = { ...process.env, ...options.env };
    execSync(command, {
      stdio: 'inherit',
      cwd: options.cwd || ROOT_DIR,
      shell: true,
      env: mergedEnv,
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
    const mergedEnv = { ...process.env, ...options.env };
    return execSync(command, {
      cwd: options.cwd || ROOT_DIR,
      shell: true,
      encoding: 'utf8',
      env: mergedEnv,
      ...options
    }).trim();
  } catch (e) {
    if (options.debug) {
      console.error('execOutput error:', e.message);
    }
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
 * Activate emsdk (Windows)
 */
function activateEmsdk() {
  if (EMSDK_DIR === 'PATH' || !IS_WINDOWS) {
    return;
  }

  console.log('Activating emsdk...');
  const emsdk = join(EMSDK_DIR, 'emsdk.bat');

  // Activate the installed version
  try {
    execSync(`"${emsdk}" activate ${EMSDK_VERSION}`, {
      cwd: EMSDK_DIR,
      stdio: 'inherit',
      shell: 'cmd.exe'
    });
  } catch (e) {
    console.warn('emsdk activate warning (may be already active)');
  }
}

/**
 * Get emsdk environment variables
 */
function getEmsdkEnv() {
  if (EMSDK_DIR === 'PATH') {
    return process.env;
  }

  const env = { ...process.env };

  if (IS_WINDOWS) {
    // Build emsdk environment manually for Windows
    const emscriptenDir = join(EMSDK_DIR, 'upstream', 'emscripten');
    const llvmDir = join(EMSDK_DIR, 'upstream', 'bin');

    // Find node directory (version may vary)
    let nodeDir = '';
    const nodePath = join(EMSDK_DIR, 'node');
    if (existsSync(nodePath)) {
      const nodeDirs = readdirSync(nodePath).filter(d => d.includes('64bit'));
      if (nodeDirs.length > 0) {
        nodeDir = join(nodePath, nodeDirs[0], 'bin');
      }
    }

    // Find python directory
    let pythonDir = '';
    const pythonPath = join(EMSDK_DIR, 'python');
    if (existsSync(pythonPath)) {
      const pythonDirs = readdirSync(pythonPath).filter(d => d.includes('64bit'));
      if (pythonDirs.length > 0) {
        pythonDir = join(pythonPath, pythonDirs[0]);
      }
    }

    // Prepend emsdk paths to PATH (Windows uses 'Path' not 'PATH')
    const emsdkPaths = [emscriptenDir, llvmDir, nodeDir, pythonDir, EMSDK_DIR].filter(Boolean);
    const currentPath = env.PATH || env.Path || '';
    env.PATH = emsdkPaths.join(';') + ';' + currentPath;
    // Also set Path for Windows compatibility
    env.Path = env.PATH;

    // Set emsdk environment variables
    env.EMSDK = EMSDK_DIR;
    env.EMSDK_NODE = nodeDir ? join(nodeDir, 'node.exe') : '';
    env.EM_CONFIG = join(EMSDK_DIR, '.emscripten');

    console.log('Configured emsdk environment manually');
    console.log('Emscripten dir:', emscriptenDir);
  } else {
    const envScript = join(EMSDK_DIR, 'emsdk_env.sh');

    if (!existsSync(envScript)) {
      console.error('emsdk_env script not found');
      return process.env;
    }

    const envOutput = execOutput(`source "${envScript}" && env`, { cwd: EMSDK_DIR });

    if (!envOutput) return process.env;

    for (const line of envOutput.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.substring(0, idx);
        const value = line.substring(idx + 1);
        env[key] = value;
      }
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
 * Force version for multiplayer compatibility
 * Temporarily hides .git and creates .ottdrev so CMake uses our version
 */
function setupForcedVersion() {
  const gitDir = join(ROOT_DIR, '.git');
  const gitBackup = join(ROOT_DIR, '.git.build-backup');
  const ottdrevFile = join(ROOT_DIR, '.ottdrev');
  const cmakeCache = join(BUILD_WASM_DIR, 'CMakeCache.txt');
  const generatedRevCpp = join(BUILD_WASM_DIR, 'generated', 'rev.cpp');

  // Delete CMake cache and generated rev.cpp to force reconfiguration
  if (existsSync(cmakeCache)) {
    unlinkSync(cmakeCache);
    console.log('Deleted CMakeCache.txt to force reconfiguration');
  }
  if (existsSync(generatedRevCpp)) {
    unlinkSync(generatedRevCpp);
    console.log('Deleted generated/rev.cpp');
  }

  // Create .ottdrev file with forced version
  // Format: version\tisodate\tmodified\thash\tistag\tisstabletag
  const ottdrevContent = `${FORCE_VERSION}\t${FORCE_VERSION_DATE}\t0\t${FORCE_VERSION_HASH}\t1\t1\n`;
  writeFileSync(ottdrevFile, ottdrevContent);
  console.log(`Created .ottdrev with version: ${FORCE_VERSION}`);

  // Temporarily rename .git so CMake uses .ottdrev
  if (existsSync(gitDir) && !existsSync(gitBackup)) {
    renameSync(gitDir, gitBackup);
    console.log('Temporarily hidden .git directory');
  }

  return { gitDir, gitBackup, ottdrevFile };
}

/**
 * Restore git directory after build
 */
function restoreGitDirectory({ gitDir, gitBackup, ottdrevFile }) {
  // Restore .git
  if (existsSync(gitBackup)) {
    renameSync(gitBackup, gitDir);
    console.log('Restored .git directory');
  }

  // Remove .ottdrev
  if (existsSync(ottdrevFile)) {
    unlinkSync(ottdrevFile);
  }
}

/**
 * Build WASM module
 */
function buildWasm(env) {
  console.log('\n=== Building WASM Module ===\n');

  if (!existsSync(BUILD_WASM_DIR)) {
    mkdirSync(BUILD_WASM_DIR, { recursive: true });
  }

  // Setup forced version for multiplayer compatibility
  console.log(`Forcing version to ${FORCE_VERSION} for multiplayer compatibility...`);
  const versionBackup = setupForcedVersion();

  try {
    const hostBinaryDir = BUILD_HOST_DIR.replace(/\\/g, '/');

    // Configure with cmake using Emscripten toolchain directly (more reliable on Windows)
    const emsdkDir = EMSDK_DIR.replace(/\\/g, '/');
    const toolchainFile = `${emsdkDir}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake`;

    const cmakeCmd = [
      'cmake ..',
      IS_WINDOWS ? '-G Ninja' : '',
      `-DCMAKE_TOOLCHAIN_FILE="${toolchainFile}"`,
      `-DHOST_BINARY_DIR="${hostBinaryDir}"`,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DOPTION_USE_ASSERTS=OFF'
    ].filter(Boolean).join(' ');

    exec(cmakeCmd, { cwd: BUILD_WASM_DIR, env });

    // Build (keep .git hidden during build too, as ninja may regenerate rev.cpp)
    const buildCmd = IS_WINDOWS
      ? 'ninja'
      : 'make -j4';

    exec(buildCmd, { cwd: BUILD_WASM_DIR, env });

    // Restore .git after build completes
    restoreGitDirectory(versionBackup);
  } catch (e) {
    // Always restore .git even on failure
    restoreGitDirectory(versionBackup);
    throw e;
  }
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
    console.log(`\n${copied} file(s) copied to web/static/`);
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

  // Activate and get emsdk environment
  activateEmsdk();
  const env = getEmsdkEnv();

  // Verify emcc works
  // On Windows, use emcc.bat explicitly
  const emccCmd = IS_WINDOWS ? 'emcc.bat --version' : 'emcc --version';
  const emccVersion = execOutput(emccCmd, { env, debug: true });
  if (!emccVersion) {
    // Try with full path as fallback
    if (IS_WINDOWS && EMSDK_DIR !== 'PATH') {
      const emccFullPath = join(EMSDK_DIR, 'upstream', 'emscripten', 'emcc.bat');
      console.log(`Trying full path: ${emccFullPath}`);
      const emccVersionFull = execOutput(`"${emccFullPath}" --version`, { env, debug: true });
      if (emccVersionFull) {
        console.log(`Emscripten: ${emccVersionFull.split('\n')[0]}`);
      } else {
        console.error('Error: emcc not working even with full path.');
        console.error('PATH includes:', env.PATH?.split(';').slice(0, 5).join('\n  '));
        process.exit(1);
      }
    } else {
      console.error('Error: emcc not working. Try running emsdk_env first.');
      process.exit(1);
    }
  } else {
    console.log(`Emscripten: ${emccVersion.split('\n')[0]}`);
  }

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
