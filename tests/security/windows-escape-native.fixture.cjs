// Authored Linux transport fixture. This never evaluates PowerShell or request data.
// Dynamic imports also work after this CJS file is installed under fixed .exe names.
void (async () => {
  const process = (await import('node:process')).default;
  const { Buffer } = await import('node:buffer');
  const { setTimeout, setInterval } = await import('node:timers');
  const { readFileSync, writeFileSync, appendFileSync } = await import('node:fs');
  const { basename, dirname, join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  try {
    const script = process.argv[1];
    const root = dirname(script);
    if (process.argv[2] === '--windows-escape-hold-pipes') {
      setTimeout(() => process.exit(0), 8000);
      return;
    }
    const role = basename(script);
    const cfg = JSON.parse(readFileSync(join(root, role + '.json'), 'utf8'));
    appendFileSync(
      join(root, 'calls.ndjson'),
      JSON.stringify({
        role,
        pid: process.pid,
        args: process.argv.slice(2),
        // Inspect only synthetic variables, never dump the host environment.
        environment: {
          GRAM_WINDOWS_ESCAPE_CANARY: process.env.GRAM_WINDOWS_ESCAPE_CANARY,
          WSLENV: process.env.WSLENV,
          node: process.env.node,
        },
      }) + '\n',
    );
    if (cfg.mode === 'exited-with-pipes' || cfg.mode === 'stderr-with-pipes') {
      const child = spawn(process.execPath, [script, '--windows-escape-hold-pipes'], {
        shell: false,
        stdio: ['ignore', process.stdout, process.stderr],
      });
      appendFileSync(join(root, 'descendants.ndjson'), JSON.stringify({ pid: child.pid, script }) + '\n');
      child.unref();
      if (cfg.mode === 'stderr-with-pipes') writeFileSync(2, cfg.diagnostic);
      process.exit(0);
    }
    if (cfg.mode === 'hang') {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      // Fixture safety net, longer than the production timeout and test assertion.
      setTimeout(() => process.exit(92), 10_000);
      return;
    }
    if (role === 'powershell.exe') {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      writeFileSync(join(root, 'stdin.bin'), Buffer.concat(chunks));
    }
    if (cfg.mode === 'signal') {
      process.kill(process.pid, 'SIGTERM');
      return;
    }
    if (cfg.mode === 'stdout-overflow') {
      process.stdout.write(Buffer.alloc(role === 'powershell.exe' ? 1048577 : 65537, 120));
      return;
    }
    if (cfg.mode === 'stderr-overflow') {
      process.stderr.write(Buffer.alloc(65537, 120));
      return;
    }
    if (cfg.mode === 'stderr' || cfg.mode === 'nonzero') process.stderr.write(cfg.diagnostic);
    if (cfg.mode === 'nonzero') {
      process.stdout.write(cfg.diagnostic);
      process.exitCode = 7;
      return;
    }
    let bytes = readFileSync(join(root, role + '.output'));
    if (role === 'wslpath' && cfg.mode === 'success') {
      const args = process.argv.slice(2);
      if (args.length !== 2 || (args[0] !== '-w' && args[0] !== '-u')) {
        process.exitCode = 93;
        return;
      }
      bytes = Buffer.from((args[0] === '-w' ? cfg.windowsPath : cfg.linuxPath) + '\n');
    }
    if (cfg.mode === 'chunked') {
      for (const byte of bytes) {
        process.stdout.write(Buffer.from([byte]));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } else {
      process.stdout.write(bytes);
    }
  } catch {
    // A malformed fixture is a failing test setup, never a clipboard diagnostic.
    process.exitCode = 94;
  }
})();
