import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const pollIntervalMs = 30_000;
const nonBlockingPolicyCheckNames = new Set([
	'Community PR Approvals',
	'VS Code PR Check',
]);

interface GhResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface CheckRun {
	name: string;
	bucket: string;
	link: string;
}

export type CiOutcome =
	| { state: 'failed'; failedChecks: CheckRun[] }
	| { state: 'passed' }
	| { state: 'pending' };

function usage(): never {
	console.error('Usage: node wait-for-ci.mts <pr-number> <owner/repo>');
	process.exit(2);
}

function runGh(args: string[]): Promise<GhResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
		child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
		child.on('error', reject);
		child.on('close', code => {
			resolve({
				exitCode: code ?? 1,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'),
			});
		});
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseChecks(stdout: string): CheckRun[] {
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) {
		throw new Error('Expected gh pr checks to return a JSON array.');
	}

	return parsed.map((item, index) => {
		if (!isRecord(item) || typeof item.name !== 'string' || typeof item.bucket !== 'string') {
			throw new Error(`Unexpected check format at index ${index}.`);
		}

		return {
			name: item.name,
			bucket: item.bucket,
			link: typeof item.link === 'string' ? item.link : '',
		};
	});
}

function printChecks(checks: CheckRun[]): void {
	if (checks.length === 0) {
		console.log('No checks reported yet.');
		return;
	}

	for (const check of checks) {
		const suffix = check.link ? `  ${check.link}` : '';
		console.log(`${check.name}\t${check.bucket}${suffix}`);
	}
}

export function evaluateChecks(checks: readonly CheckRun[]): CiOutcome {
	const blockingChecks = checks.filter(check => !nonBlockingPolicyCheckNames.has(check.name));
	const failedChecks = blockingChecks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel');
	if (failedChecks.length > 0) {
		return { state: 'failed', failedChecks };
	}

	const allDone = blockingChecks.length > 0
		&& blockingChecks.every(check => check.bucket === 'pass' || check.bucket === 'skipping');
	return { state: allDone ? 'passed' : 'pending' };
}

async function main(): Promise<void> {
	const [prNumber, repo] = process.argv.slice(2);
	if (!prNumber || !repo) {
		usage();
	}

	console.log(`Waiting for CI on PR #${prNumber} (${repo})...`);

	while (true) {
		console.log(`--- Checking CI at ${new Date().toString()} ---`);
		let result: GhResult;
		try {
			result = await runGh(['pr', 'checks', prNumber, '--repo', repo, '--json', 'name,bucket,link']);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			console.log('');
			console.log('RESULT: CI_ERROR');
			process.exit(2);
		}
		if (result.stderr.trim()) {
			console.error(result.stderr.trim());
		}

		let checks: CheckRun[];
		try {
			checks = parseChecks(result.stdout);
		} catch (error) {
			if (result.stdout.trim()) {
				console.log(result.stdout.trim());
			}
			console.error(error instanceof Error ? error.message : String(error));
			console.log('');
			console.log('RESULT: CI_ERROR');
			process.exit(2);
		}

		printChecks(checks);

		const ignoredChecks = checks.filter(check => nonBlockingPolicyCheckNames.has(check.name));
		if (ignoredChecks.length > 0) {
			console.log(`Ignoring non-build policy checks: ${ignoredChecks.map(check => check.name).join(', ')}`);
		}

		const outcome = evaluateChecks(checks);
		if (outcome.state === 'failed') {
			console.log('');
			console.log('RESULT: CI_FAILED');
			console.log('FAILED_CHECKS:');
			for (const check of outcome.failedChecks) {
				const suffix = check.link ? `  ${check.link}` : '';
				console.log(`- ${check.name}${suffix}`);
			}
			process.exit(1);
		}

		if (outcome.state === 'passed') {
			console.log('');
			console.log('RESULT: CI_PASSED');
			console.log('All CI checks have passed.');
			process.exit(0);
		}

		console.log('Still waiting for CI...');
		await setTimeout(pollIntervalMs);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}