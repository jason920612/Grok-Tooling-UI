import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WALL_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const CPU_TIME_SECONDS = 30;
const MAX_OUTPUT_FILE_BYTES = 60 * 1024 * 1024;
const PACKAGE_PATTERN = /^[a-zA-Z0-9_.-]+(?:\[[a-zA-Z0-9_,.-]+\])?(?:[<>=!~]=?[a-zA-Z0-9*_.+-]+)?$/;

export type PythonExecutionInput = {
  code: string;
  packages?: string[];
};

function normalizePackages(packages: unknown) {
  if (!Array.isArray(packages)) return [];

  return packages
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((pkg) => {
      if (!PACKAGE_PATTERN.test(pkg)) {
        throw new Error(`Unsupported pip package spec: ${pkg}`);
      }
      return pkg;
    });
}

async function getDirectorySize(directory: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(fullPath);
    } else if (entry.isFile()) {
      total += (await fs.stat(fullPath)).size;
    }
  }

  return total;
}

async function listOutputFiles(directory: string, root = directory) {
  const files: Array<{ path: string; size: number }> = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listOutputFiles(fullPath, root));
    } else if (entry.isFile()) {
      const stats = await fs.stat(fullPath);
      files.push({
        path: path.relative(root, fullPath),
        size: stats.size
      });
    }
  }

  return files;
}

function detectMime(filename: string) {
  const extension = path.extname(filename).toLowerCase();
  const mimeByExtension: Record<string, string> = {
    '.html': 'text/html;charset=utf-8',
    '.htm': 'text/html;charset=utf-8',
    '.txt': 'text/plain;charset=utf-8',
    '.md': 'text/markdown;charset=utf-8',
    '.json': 'application/json;charset=utf-8',
    '.csv': 'text/csv;charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf'
  };

  return mimeByExtension[extension] || 'application/octet-stream';
}

function isPreviewable(mime: string) {
  return mime.startsWith('text/')
    || mime.startsWith('image/')
    || mime.startsWith('application/json')
    || mime.startsWith('image/svg+xml')
    || mime.startsWith('application/pdf');
}

async function readOutputArtifacts(directory: string) {
  const files = await listOutputFiles(directory);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_OUTPUT_FILE_BYTES) {
    throw new Error('Python output files exceeded the 60MB limit.');
  }

  const artifacts = [];
  for (const file of files) {
    const fullPath = path.join(directory, file.path);
    const mime = detectMime(file.path);
    artifacts.push({
      name: file.path.replaceAll(path.sep, '/'),
      size: file.size,
      mime,
      previewable: isPreviewable(mime),
      content_base64: (await fs.readFile(fullPath)).toString('base64')
    });
  }

  return artifacts;
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = WALL_TIMEOUT_MS) {
  return execFileAsync(command, args, {
    cwd,
    env,
    timeout,
    maxBuffer: MAX_BUFFER_BYTES
  });
}

export async function runEphemeralPython(input: unknown) {
  const code = String((input as { code?: unknown }).code ?? '').trim();
  if (!code) throw new Error('python_execution requires code.');

  const packages = normalizePackages((input as { packages?: unknown }).packages);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-tooling-python-'));
  const outputDirectory = path.join(root, 'outputs');
  const venvDirectory = path.join(root, '.venv');
  const codePath = path.join(root, 'main.py');
  const runnerPath = path.join(root, 'runner.py');
  const deadline = Date.now() + WALL_TIMEOUT_MS;

  function remainingTime() {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Python execution exceeded the 60 second wall-time limit.');
    return remaining;
  }

  try {
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(codePath, code, 'utf8');
    await fs.writeFile(runnerPath, `
import os
import resource
import runpy
import sys

resource.setrlimit(resource.RLIMIT_AS, (${MEMORY_LIMIT_BYTES}, ${MEMORY_LIMIT_BYTES}))
resource.setrlimit(resource.RLIMIT_CPU, (${CPU_TIME_SECONDS}, ${CPU_TIME_SECONDS}))
resource.setrlimit(resource.RLIMIT_FSIZE, (${MAX_OUTPUT_FILE_BYTES}, ${MAX_OUTPUT_FILE_BYTES}))

os.chdir(${JSON.stringify(root)})
os.environ["GROK_OUTPUT_DIR"] = ${JSON.stringify(outputDirectory)}
sys.path.insert(0, ${JSON.stringify(root)})
runpy.run_path(${JSON.stringify(codePath)}, run_name="__main__")
`, 'utf8');

    await run('python3', ['-m', 'venv', venvDirectory], root, {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PYTHONDONTWRITEBYTECODE: '1'
    }, remainingTime());

    const python = path.join(venvDirectory, 'bin', 'python');
    const pip = path.join(venvDirectory, 'bin', 'pip');
    const installOutput = packages.length
      ? await run(pip, ['install', '--no-input', ...packages], root, {
          ...process.env,
          PIP_DISABLE_PIP_VERSION_CHECK: '1',
          PIP_REQUIRE_VIRTUALENV: '1'
        }, remainingTime())
      : { stdout: '', stderr: '' };

    const execution = await run(python, [runnerPath], root, {
      PATH: `${path.join(venvDirectory, 'bin')}:${process.env.PATH ?? ''}`,
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      VIRTUAL_ENV: venvDirectory,
      GROK_OUTPUT_DIR: outputDirectory
    }, remainingTime());

    const outputBytes = await getDirectorySize(outputDirectory);
    const artifacts = await readOutputArtifacts(outputDirectory);

    return {
      stdout: execution.stdout.slice(0, 20_000),
      stderr: execution.stderr.slice(0, 20_000),
      pip_stdout: installOutput.stdout.slice(0, 8_000),
      pip_stderr: installOutput.stderr.slice(0, 8_000),
      packages,
      limits: {
        wall_time_seconds: 60,
        cpu_time_seconds: CPU_TIME_SECONDS,
        memory_mb: 512,
        max_output_files_mb: 60
      },
      output_files: artifacts.map(({ content_base64: _content, ...artifact }) => artifact),
      output_bytes: outputBytes,
      artifacts
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
