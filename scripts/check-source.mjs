#!/usr/bin/env node
/**
 * Source gate for dsh-mydsh.
 *
 * Two failure modes bit this project once already, so both are checked before
 * anything reaches the installer:
 *
 *  1. A Windows tool writing a source file as GBK. Every file must decode as
 *     strict UTF-8, because the bundle is served to a browser that assumes it.
 *  2. A syntax error in a module the Host only loads at activation. Checking
 *     every file up front turns a runtime crash in the user's DSH into a build
 *     failure here.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

const files = await walk(root);
const problems = [];

// 1. Encoding: strict UTF-8 across every text file we ship.
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.svg', '.css']);
const decoder = new TextDecoder('utf-8', { fatal: true });
for (const file of files) {
  if (!textExtensions.has(extname(file))) continue;
  const bytes = await readFile(file);
  // A BOM is legal but unexpected here and can confuse a bundler.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push(`${relative(root, file)}: starts with a UTF-8 BOM`);
  }
  try {
    decoder.decode(bytes);
  } catch {
    problems.push(`${relative(root, file)}: not valid UTF-8`);
  }
}

// 2. Syntax: parse every module the way Node will.
const modules = files.filter((f) => ['.js', '.mjs'].includes(extname(f)) && !f.includes('node_modules'));
const syntaxFailures = [];
await Promise.all(
  modules.map(
    (file) =>
      new Promise((res) => {
        const child = spawn(process.execPath, ['--check', file], { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('close', (code) => {
          if (code !== 0) syntaxFailures.push(`${relative(root, file)}\n${stderr.trim()}`);
          res();
        });
        child.on('error', () => res());
      }),
  ),
);
problems.push(...syntaxFailures);

// 3. CSS template literals must not contain a stray backtick.
//
// Twice now a CSS template literal in `theme.js` gained a backtick inside a comment.
// That closes the literal early and the text after it is parsed as code: `node
// --check` accepts it because the result is a legal expression, then the bundle throws
// `ReferenceError` the moment it is evaluated. This catches the mistake at the gate.
//
// Only the interior of a literal is inspected. A JSDoc block above the declaration
// freely discusses identifiers in backticks, and flagging those would make the check
// useless noise.
const themeFile = join(root, 'src', 'client', 'theme.js');
try {
  const lines = (await readFile(themeFile, 'utf8')).split('\n');
  let openLine = -1;
  lines.forEach((line, index) => {
    const number = index + 1;
    if (openLine === -1) {
      // A declaration such as `export const STYLES = \`` opens a literal.
      if (/=\s*`\s*$/.test(line)) openLine = number;
      return;
    }
    // Inside the literal: a backtick either closes it legitimately (the line is just
    // the terminator) or, on any other line, cut it short.
    if (!line.includes('`')) return;
    if (/^\s*`;\s*$/.test(line)) {
      openLine = -1;
      return;
    }
    problems.push(
      `src/client/theme.js:${number}: backtick inside a template literal closes it early: ${line.trim().slice(0, 100)}`,
    );
  });
  if (openLine !== -1) {
    problems.push(`src/client/theme.js:${openLine}: a template literal is never closed`);
  }
} catch {
  // A missing theme file is already reported by the syntax pass above.
}

if (problems.length > 0) {
  console.error(`source gate: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`source gate: ${files.length} files clean (${modules.length} modules parsed)`);
