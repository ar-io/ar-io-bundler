#!/usr/bin/env node
/**
 * Generate a scrypt hash for the admin dashboard password.
 *
 * Usage:
 *   yarn workspace @ar-io-bundler/admin-service hash-password 'my secret password'
 *   # or interactively (no echo):
 *   yarn workspace @ar-io-bundler/admin-service hash-password
 *
 * Copy the printed value into ADMIN_PASSWORD_HASH in your .env and remove any
 * plaintext ADMIN_PASSWORD.
 */

const { hashPassword } = require('../admin/middleware/session');

async function printResult(password) {
  if (!password) {
    console.error('Error: empty password.');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  console.log('\nADMIN_PASSWORD_HASH=' + hash + '\n');
  console.log('Add the line above to your .env (and remove ADMIN_PASSWORD).');
}

const fromArg = process.argv.slice(2).join(' ').trim();
if (fromArg) {
  printResult(fromArg);
} else {
  // Interactive, no-echo prompt.
  process.stdout.write('Password: ');
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  let input = '';
  stdin.on('data', (char) => {
    if (char === '\r' || char === '\n' || char === '') {
      if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
      stdin.pause();
      process.stdout.write('\n');
      printResult(input.trim());
      return;
    }
    if (char === '') {
      // Ctrl-C
      process.stdout.write('\n');
      process.exit(130);
    }
    if (char === '' || char === '\b') {
      input = input.slice(0, -1);
      return;
    }
    input += char;
  });
}
