#!/usr/bin/env node
/**
 * Mirrors the server domain contract into the browser bundle.
 *
 * The web workspace cannot import across the workspace boundary without
 * dragging server-only code (and its Node types) into the browser build, so the
 * type-only prefix of server/src/domain/types.ts is copied verbatim, stopping
 * at AppError, which is server-side error plumbing.
 *
 * Run after editing the contract; `npm run typecheck` will otherwise start
 * disagreeing between the two workspaces.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'server/src/domain/types.ts');
const dest = resolve(root, 'web/src/shared/types.ts');

const source = await readFile(src, 'utf8');
const cut = source.indexOf('export class AppError');
const body = cut === -1 ? source : source.slice(0, cut);

const header = [
  '// AUTO-MIRRORED from server/src/domain/types.ts — do not edit by hand.',
  '// Run `node scripts/sync-types.mjs` after changing the server contract.',
  '',
].join('\n');

await writeFile(dest, header + body, 'utf8');
console.log(`synced ${body.split('\n').length} lines -> web/src/shared/types.ts`);
