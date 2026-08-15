import { deepStrictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import {
	copilotReviewWaitTimeoutMs,
	evaluateCopilotReviewExpectation,
	evaluateCopilotReviewPoll,
} from './wait-for-copilot-review.mts';

describe('evaluateCopilotReviewPoll', () => {
	it('reports comments as soon as an unresolved thread appears', () => {
		deepStrictEqual(evaluateCopilotReviewPoll({
			unresolvedCommentCount: 1,
			newReviewCount: 0,
			deadlineReached: false,
		}), 'comments');
	});

	it('reports a new review even when it has no comments', () => {
		deepStrictEqual(evaluateCopilotReviewPoll({
			unresolvedCommentCount: 0,
			newReviewCount: 1,
			deadlineReached: false,
		}), 'review');
	});

	it('keeps waiting until the deadline without consulting requested reviewers', () => {
		deepStrictEqual(evaluateCopilotReviewPoll({
			unresolvedCommentCount: 0,
			newReviewCount: 0,
			deadlineReached: false,
		}), 'pending');
	});

	it('times out after a bounded window', () => {
		deepStrictEqual(copilotReviewWaitTimeoutMs, 15 * 60_000);
		deepStrictEqual(evaluateCopilotReviewPoll({
			unresolvedCommentCount: 0,
			newReviewCount: 0,
			deadlineReached: true,
		}), 'timeout');
	});

	it('prefers comments over the timeout boundary', () => {
		deepStrictEqual(evaluateCopilotReviewPoll({
			unresolvedCommentCount: 1,
			newReviewCount: 0,
			deadlineReached: true,
		}), 'comments');
	});
});

describe('evaluateCopilotReviewExpectation', () => {
	it('expects an initial review for Microsoft VS Code repositories', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'microsoft/vscode-team-kit',
			true,
			false,
			undefined,
			0,
			false,
		), {
			expected: true,
			reason: 'microsoft/vscode-team-kit is a Microsoft VS Code repository without an existing Copilot review',
		});
	});

	it('does not expect another VS Code review after one already exists', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'microsoft/vscode-team-kit',
			false,
			false,
			undefined,
			1,
			false,
		).expected, false);
	});

	it('expects a visible explicit Copilot request', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'owner/repo',
			false,
			true,
			undefined,
			1,
			true,
		).expected, true);
	});

	it('expects an applicable automatic review rule', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'owner/repo',
			false,
			false,
			{ reviewDraftPullRequests: false, reviewOnPush: false },
			0,
			false,
		).expected, true);
	});

	it('does not wait when no review signal exists', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'owner/repo',
			false,
			false,
			undefined,
			0,
			false,
		).expected, false);
	});

	it('does not wait for drafts excluded by the automatic review rule', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'owner/repo',
			true,
			false,
			{ reviewDraftPullRequests: false, reviewOnPush: false },
			0,
			false,
		).expected, false);
	});

	it('waits for drafts included by the automatic review rule', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'owner/repo',
			true,
			false,
			{ reviewDraftPullRequests: true, reviewOnPush: false },
			0,
			false,
		).expected, true);
	});

	it('does not wait for another review when new pushes are not reviewed', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'owner/repo',
			false,
			false,
			{ reviewDraftPullRequests: false, reviewOnPush: false },
			1,
			false,
		).expected, false);
	});

	it('waits for a pushed commit when the rule reviews new pushes', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'owner/repo',
			false,
			false,
			{ reviewDraftPullRequests: false, reviewOnPush: true },
			1,
			false,
		).expected, true);
	});

	it('does not wait when the current head commit was already reviewed', () => {
		deepStrictEqual(evaluateCopilotReviewExpectation(
			'owner/repo',
			false,
			false,
			{ reviewDraftPullRequests: false, reviewOnPush: true },
			1,
			true,
		).expected, false);
	});
});
