import { deepStrictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { evaluateChecks, getOutstandingPolicyChecks, hasMergeConflict } from './wait-for-ci.mts';
import type { CheckRun } from './wait-for-ci.mts';

function check(name: string, bucket: string): CheckRun {
	return { name, bucket, link: '' };
}

describe('evaluateChecks', () => {
	it('passes when builds are complete and review policy checks are pending', () => {
		deepStrictEqual(evaluateChecks([
			check('Compile & Hygiene', 'pass'),
			check('Linux / Electron', 'pass'),
			check('VS Code PR Check', 'pending'),
			check('Community PR Approvals', 'pending'),
		]), { state: 'passed' });
	});

	it('keeps waiting for pending builds', () => {
		deepStrictEqual(evaluateChecks([
			check('Compile & Hygiene', 'pass'),
			check('Linux / Electron', 'pending'),
			check('VS Code PR Check', 'pending'),
			check('Community PR Approvals', 'pending'),
		]), { state: 'pending' });
	});

	it('reports failed builds', () => {
		const failedCheck = check('Linux / Electron', 'fail');
		deepStrictEqual(evaluateChecks([
			check('Compile & Hygiene', 'pass'),
			failedCheck,
			check('VS Code PR Check', 'pending'),
		]), { state: 'failed', failedChecks: [failedCheck] });
	});

	it('does not fail on non-build policy checks', () => {
		deepStrictEqual(evaluateChecks([
			check('Compile & Hygiene', 'pass'),
			check('VS Code PR Check', 'fail'),
			check('Community PR Approvals', 'cancel'),
		]), { state: 'passed' });
	});

	it('waits until at least one build check is reported', () => {
		deepStrictEqual(evaluateChecks([
			check('VS Code PR Check', 'pending'),
			check('Community PR Approvals', 'pending'),
		]), { state: 'pending' });
	});
});

describe('hasMergeConflict', () => {
	it('detects conflicting mergeability', () => {
		deepStrictEqual(hasMergeConflict({
			mergeable: 'CONFLICTING',
			mergeStateStatus: 'BLOCKED',
		}), true);
	});

	it('detects a dirty merge state', () => {
		deepStrictEqual(hasMergeConflict({
			mergeable: 'UNKNOWN',
			mergeStateStatus: 'DIRTY',
		}), true);
	});

	it('allows non-conflicting merge states', () => {
		deepStrictEqual(hasMergeConflict({
			mergeable: 'MERGEABLE',
			mergeStateStatus: 'CLEAN',
		}), false);
	});
});

describe('getOutstandingPolicyChecks', () => {
	it('returns only non-passing policy checks', () => {
		const pendingPolicyCheck = check('VS Code PR Check', 'pending');
		deepStrictEqual(getOutstandingPolicyChecks([
			check('Compile & Hygiene', 'pass'),
			pendingPolicyCheck,
			check('Community PR Approvals', 'pass'),
		]), [pendingPolicyCheck]);
	});
});
