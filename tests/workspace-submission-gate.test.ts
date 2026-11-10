import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, readdirSync, writeFileSync, rmSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceSubmissionGate} from '../src/workspace-submission-gate';
import type {WorkspaceRequestRow} from '../src/workspace-request-store';
const row: WorkspaceRequestRow = {requester: '~nec', nonce: '12345678-1234-4234-8234-123456789abc', requestDigest: '0xa', project: 'demo', session: '0xb', status: 'reserved'};
const execute = promisify(execFile);

test('separate processes compete for one durable shared request claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-claim-process-'));
  const script = `const {WorkspaceSubmissionGate}=require(process.argv[1]);
try {new WorkspaceSubmissionGate(process.argv[2], 'https://zod.example', '~zod').claim(JSON.parse(process.argv[3])); process.stdout.write('claimed');}
catch(e) {if (!e.message.includes('already claimed')) throw e; process.stdout.write('retained');}`;
  try {
    const args = ['-e', script, require.resolve('../src/workspace-submission-gate'), directory, JSON.stringify(row)];
    const results = await Promise.all([execute(process.execPath, args), execute(process.execPath, args)]);
    assert.deepEqual(results.map(r => r.stdout).sort(), ['claimed', 'retained']);
    assert.equal(readdirSync(directory).length, 1);
    assert.equal((await execute(process.execPath, args)).stdout, 'retained');
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('partial claims and changed digests never free the native identity slot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-claim-partial-'));
  try {
    const gate = new WorkspaceSubmissionGate(directory, 'https://zod.example', '~zod');
    gate.claim(row); writeFileSync(join(directory, readdirSync(directory)[0]), '');
    assert.throws(() => gate.claim(row), /already claimed/);
    assert.throws(() => gate.claim({...row, requestDigest: '0xc'}), /already claimed/);
    new WorkspaceSubmissionGate(directory, 'https://other.example', '~zod').claim(row);
    new WorkspaceSubmissionGate(directory, 'https://zod.example', '~bud').claim(row);
    assert.equal(readdirSync(directory).length, 3);
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('shared claims refuse an exposed directory before creating a claim', () => {
  const directory = mkdtempSync(join(tmpdir(), 'readymade-claim-mode-'));
  try {
    chmodSync(directory, 0o755);
    assert.throws(() => new WorkspaceSubmissionGate(directory, 'https://zod.example', '~zod').claim(row), /private and owned/);
    assert.equal(readdirSync(directory).length, 0);
  } finally {rmSync(directory, {recursive: true, force: true});}
});
