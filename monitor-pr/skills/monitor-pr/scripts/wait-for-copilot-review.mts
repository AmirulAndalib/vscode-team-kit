import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/**
 * wait-for-copilot-review.mts
 *
 * Waits (if needed) for Copilot to finish reviewing a pull request, then
 * prints a single `RESULT: <STATE>` line so the calling agent knows whether
 * there are Copilot comments to act on.
 *
 * Usage:
 *   node wait-for-copilot-review.mts <pr-number> <owner/repo>
 *
 * Logic:
 *
 *   1. On startup, fetch the PR's Copilot-authored review threads.
 *      If any are unresolved, exit immediately with
 *      `UNRESOLVED_COPILOT_REVIEW_COMMENTS` and print each comment.
 *
 *   2. Determine whether a review is expected. Microsoft VS Code repositories,
 *      an applicable automatic-review branch rule, or a visible explicit
 *      request are positive signals. If none apply, exit immediately.
 *      Automatic reviews do not reliably appear in `requested_reviewers`, so
 *      an absent request never cancels another positive signal.
 *
 *   3. If a review is expected, poll every `pollIntervalMs`:
 *        a. Re-fetch unresolved Copilot threads and exit as soon as comments
 *           appear.
 *        b. Re-fetch completed Copilot reviews. Any review whose ID was not
 *           present at startup is a new review -> exit with
 *           `NEW_COPILOT_REVIEW` and print each inline comment on it.
 *        c. If neither appears before the bounded window ends, exit with
 *           `COPILOT_REVIEW_TIMEOUT`.
 *
 * Any unexpected `gh` or GraphQL failure prints the error and exits with
 * `COPILOT_REVIEW_ERROR` (exit code 2).
 */

const pollIntervalMs = 30_000;
export const copilotReviewWaitTimeoutMs = 15 * 60_000;

export type CopilotReviewPollOutcome = 'comments' | 'review' | 'timeout' | 'pending';

export interface CopilotReviewPollState {
	unresolvedCommentCount: number;
	newReviewCount: number;
	deadlineReached: boolean;
}

export interface CopilotReviewRule {
	reviewDraftPullRequests: boolean;
	reviewOnPush: boolean;
}

export interface CopilotReviewExpectation {
	expected: boolean;
	reason: string;
}

export function evaluateCopilotReviewPoll(state: CopilotReviewPollState): CopilotReviewPollOutcome {
	if (state.unresolvedCommentCount > 0) {
		return 'comments';
	}
	if (state.newReviewCount > 0) {
		return 'review';
	}
	return state.deadlineReached ? 'timeout' : 'pending';
}

export function evaluateCopilotReviewExpectation(
	repo: string,
	isDraft: boolean,
	hasExplicitRequest: boolean,
	rule: CopilotReviewRule | undefined,
	existingReviewCount: number,
	hasReviewForHead: boolean,
): CopilotReviewExpectation {
	const { owner, name } = parseRepo(repo);
	if (hasExplicitRequest) {
		return { expected: true, reason: 'Copilot is currently listed as a requested reviewer' };
	}
	const isMicrosoftVsCodeRepo = owner.toLowerCase() === 'microsoft' && name.toLowerCase().startsWith('vscode');
	if (rule === undefined) {
		if (isMicrosoftVsCodeRepo && existingReviewCount === 0) {
			return { expected: true, reason: `${owner}/${name} is a Microsoft VS Code repository without an existing Copilot review` };
		}
		if (isMicrosoftVsCodeRepo) {
			return { expected: false, reason: 'a Copilot review already exists and no re-review signal was found' };
		}
		return { expected: false, reason: 'no applicable automatic Copilot review rule or explicit request was found' };
	}
	if (isDraft && !rule.reviewDraftPullRequests) {
		return { expected: false, reason: 'the applicable automatic review rule excludes draft pull requests' };
	}
	if (existingReviewCount > 0 && !rule.reviewOnPush) {
		return { expected: false, reason: 'a Copilot review already exists and the automatic review rule does not review new pushes' };
	}
	if (hasReviewForHead) {
		return { expected: false, reason: 'the current head commit already has a Copilot review and no explicit re-review was requested' };
	}
	return { expected: true, reason: 'an applicable automatic Copilot review rule was found' };
}

interface GhResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface PrInfo {
	number: number;
	title: string;
	url: string;
	headRefName: string;
	headRefOid: string;
	baseRefName: string;
	isDraft: boolean;
}

interface Review {
	id: number;
	user: { login: string };
	state: string;
	submitted_at: string;
	commit_id: string;
}

interface ReviewComment {
	id: number;
	pull_request_review_id: number | null;
	user: { login: string };
	path: string;
	line: number | null;
	start_line: number | null;
	original_line: number | null;
	side: string;
	body: string;
	created_at: string;
}

interface ReviewThreadComment {
	id: number;
	user: { login: string };
	path: string;
	line: number | null;
	original_line: number | null;
	body: string;
	created_at: string;
}

interface ReviewThreadLocation {
	id: string;
	path: string;
	line: number | null;
	original_line: number | null;
}

interface PageInfo {
	hasNextPage: boolean;
	endCursor: string | null;
}

function usage(): never {
	console.error('Usage: node wait-for-copilot-review.mts <pr-number> <owner/repo>');
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

async function ghJson(args: string[]): Promise<unknown> {
	const result = await runGh(args);
	if (result.exitCode !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `gh ${args.join(' ')} failed with exit code ${result.exitCode}`;
		throw new Error(message);
	}
	if (result.stderr.trim()) {
		console.error(result.stderr.trim());
	}
	return JSON.parse(result.stdout);
}

async function ghJsonArray(args: string[]): Promise<unknown[]> {
	const data = await ghJson(args);
	if (!Array.isArray(data)) {
		throw new Error('Expected gh API response to be an array.');
	}
	if (args.includes('--slurp')) {
		return data.flatMap(page => {
			if (!Array.isArray(page)) {
				throw new Error('Expected paginated gh API response page to be an array.');
			}
			return page;
		});
	}
	return data;
}

function parseRepo(repo: string): { owner: string; name: string } {
	const [owner, name, extra] = repo.split('/');
	if (!owner || !name || extra !== undefined) {
		throw new Error(`Expected repo in owner/name format, got: ${repo}`);
	}
	return { owner, name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getRecord(value: Record<string, unknown>, property: string, context: string): Record<string, unknown> {
	const nested = value[property];
	if (!isRecord(nested)) {
		throw new Error(`Unexpected GraphQL response: expected ${context}.${property} to be an object.`);
	}
	return nested;
}

function getArray(value: Record<string, unknown>, property: string, context: string): unknown[] {
	const nested = value[property];
	if (!Array.isArray(nested)) {
		throw new Error(`Unexpected GraphQL response: expected ${context}.${property} to be an array.`);
	}
	return nested;
}

function parsePageInfo(value: unknown, context: string): PageInfo {
	if (!isRecord(value) || typeof value.hasNextPage !== 'boolean') {
		throw new Error(`Unexpected GraphQL response: expected ${context}.pageInfo.`);
	}
	return {
		hasNextPage: value.hasNextPage,
		endCursor: typeof value.endCursor === 'string' ? value.endCursor : null,
	};
}

async function getPrInfo(prNumber: string, repo: string): Promise<PrInfo> {
	const data = await ghJson([
		'pr', 'view', prNumber,
		'--repo', repo,
		'--json', 'number,title,url,headRefName,headRefOid,baseRefName,isDraft',
	]);
	if (!isRecord(data)) {
		throw new Error('Unexpected response from gh pr view.');
	}
	return {
		number: typeof data.number === 'number' ? data.number : Number(data.number),
		title: typeof data.title === 'string' ? data.title : '',
		url: typeof data.url === 'string' ? data.url : '',
		headRefName: typeof data.headRefName === 'string' ? data.headRefName : '',
		headRefOid: typeof data.headRefOid === 'string' ? data.headRefOid : '',
		baseRefName: typeof data.baseRefName === 'string' ? data.baseRefName : '',
		isDraft: data.isDraft === true,
	};
}

async function getReviews(prNumber: string, repo: string): Promise<Review[]> {
	const data = await ghJsonArray([
		'api', '--paginate', '--slurp',
		`repos/${repo}/pulls/${prNumber}/reviews`,
	]);
	return data.map((item, index): Review => {
		if (!isRecord(item) || !isRecord(item.user) || typeof item.user.login !== 'string' || typeof item.id !== 'number') {
			throw new Error(`Unexpected review format at index ${index}.`);
		}
		return {
			id: item.id,
			user: { login: item.user.login },
			state: typeof item.state === 'string' ? item.state : '',
			submitted_at: typeof item.submitted_at === 'string' ? item.submitted_at : '',
			commit_id: typeof item.commit_id === 'string' ? item.commit_id : '',
		};
	});
}

async function hasExplicitCopilotReviewRequest(prNumber: string, repo: string): Promise<boolean> {
	const data = await ghJson([
		'api', `repos/${repo}/pulls/${prNumber}/requested_reviewers`,
	]);
	if (!isRecord(data) || !Array.isArray(data.users)) {
		throw new Error('Unexpected response from the requested reviewers API.');
	}
	return data.users.some(user =>
		isRecord(user)
		&& typeof user.login === 'string'
		&& isCopilotLogin(user.login)
	);
}

async function getCopilotReviewRule(repo: string, baseBranch: string): Promise<CopilotReviewRule | undefined> {
	const data = await ghJson([
		'api', `repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}`,
	]);
	if (!Array.isArray(data)) {
		throw new Error('Unexpected response from the active branch rules API.');
	}

	for (const rule of data) {
		if (!isRecord(rule) || rule.type !== 'copilot_code_review') {
			continue;
		}
		const parameters = rule.parameters;
		if (
			!isRecord(parameters)
			|| typeof parameters.review_draft_pull_requests !== 'boolean'
			|| typeof parameters.review_on_push !== 'boolean'
		) {
			throw new Error('Unexpected copilot_code_review rule parameters.');
		}
		return {
			reviewDraftPullRequests: parameters.review_draft_pull_requests,
			reviewOnPush: parameters.review_on_push,
		};
	}
	return undefined;
}

async function getReviewComments(prNumber: string, repo: string): Promise<ReviewComment[]> {
	const data = await ghJsonArray([
		'api', '--paginate', '--slurp',
		`repos/${repo}/pulls/${prNumber}/comments`,
	]);
	return data.map((item, index): ReviewComment => {
		if (!isRecord(item) || !isRecord(item.user) || typeof item.user.login !== 'string' || typeof item.id !== 'number') {
			throw new Error(`Unexpected review comment format at index ${index}.`);
		}
		return {
			id: item.id,
			pull_request_review_id: typeof item.pull_request_review_id === 'number' ? item.pull_request_review_id : null,
			user: { login: item.user.login },
			path: typeof item.path === 'string' ? item.path : '',
			line: typeof item.line === 'number' ? item.line : null,
			start_line: typeof item.start_line === 'number' ? item.start_line : null,
			original_line: typeof item.original_line === 'number' ? item.original_line : null,
			side: typeof item.side === 'string' ? item.side : '',
			body: typeof item.body === 'string' ? item.body : '',
			created_at: typeof item.created_at === 'string' ? item.created_at : '',
		};
	});
}

function parseReviewThreadComment(commentNode: unknown, thread: ReviewThreadLocation, context: string): ReviewThreadComment | undefined {
	if (!isRecord(commentNode)) {
		throw new Error(`Unexpected review thread comment format at ${context}.`);
	}
	const author = commentNode.author;
	if (!isRecord(author) || typeof author.login !== 'string' || !isCopilotLogin(author.login)) {
		return undefined;
	}

	return {
		id: typeof commentNode.databaseId === 'number' ? commentNode.databaseId : 0,
		user: { login: author.login },
		path: typeof commentNode.path === 'string' ? commentNode.path : thread.path,
		line: typeof commentNode.line === 'number' ? commentNode.line : thread.line,
		original_line: typeof commentNode.originalLine === 'number' ? commentNode.originalLine : thread.original_line,
		body: typeof commentNode.body === 'string' ? commentNode.body : '',
		created_at: typeof commentNode.createdAt === 'string' ? commentNode.createdAt : '',
	};
}

async function getAdditionalReviewThreadComments(thread: ReviewThreadLocation, after: string): Promise<ReviewThreadComment[]> {
	const query = `
		query($id: ID!, $after: String) {
			node(id: $id) {
				... on PullRequestReviewThread {
					comments(first: 100, after: $after) {
						pageInfo {
							hasNextPage
							endCursor
						}
						nodes {
							databaseId
							author {
								login
							}
							body
							path
							line
							originalLine
							createdAt
						}
					}
				}
			}
		}`;

	let nextAfter: string | undefined = after;
	const comments: ReviewThreadComment[] = [];

	while (nextAfter !== undefined) {
		const data = await ghJson([
			'api', 'graphql',
			'-f', `query=${query}`,
			'-F', `id=${thread.id}`,
			'-f', `after=${nextAfter}`,
		]);
		if (!isRecord(data)) {
			throw new Error('Unexpected GraphQL response: expected an object.');
		}
		const responseData = getRecord(data, 'data', 'response');
		const node = getRecord(responseData, 'node', 'data');
		const threadComments = getRecord(node, 'comments', 'node');
		const pageInfo = parsePageInfo(threadComments.pageInfo, 'comments');
		const commentNodes = getArray(threadComments, 'nodes', 'comments');

		for (const [commentIndex, commentNode] of commentNodes.entries()) {
			const parsed = parseReviewThreadComment(commentNode, thread, `node.comments.nodes[${commentIndex}]`);
			if (parsed !== undefined) {
				comments.push(parsed);
			}
		}

		nextAfter = pageInfo.hasNextPage && pageInfo.endCursor !== null ? pageInfo.endCursor : undefined;
	}

	return comments;
}

interface CopilotReviewThreadState {
	unresolved: ReviewThreadComment[];
	resolvedCopilotThreadCount: number;
}

async function getCopilotReviewThreadState(prNumber: string, repo: string): Promise<CopilotReviewThreadState> {
	const { owner, name } = parseRepo(repo);
	const query = `
		query($owner: String!, $name: String!, $number: Int!, $after: String) {
			repository(owner: $owner, name: $name) {
				pullRequest(number: $number) {
					reviewThreads(first: 100, after: $after) {
						pageInfo {
							hasNextPage
							endCursor
						}
						nodes {
							id
							isResolved
							path
							line
							originalLine
							comments(first: 100) {
								pageInfo {
									hasNextPage
									endCursor
								}
								nodes {
									databaseId
									author {
										login
									}
									body
									path
									line
									originalLine
									createdAt
								}
							}
						}
					}
				}
			}
		}`;

	let after: string | undefined;
	const unresolved: ReviewThreadComment[] = [];
	let resolvedCopilotThreadCount = 0;

	do {
		const args = [
			'api', 'graphql',
			'-f', `query=${query}`,
			'-F', `owner=${owner}`,
			'-F', `name=${name}`,
			'-F', `number=${prNumber}`,
		];
		if (after !== undefined) {
			args.push('-f', `after=${after}`);
		}

		const data = await ghJson(args);
		if (!isRecord(data)) {
			throw new Error('Unexpected GraphQL response: expected an object.');
		}
		const responseData = getRecord(data, 'data', 'response');
		const repository = getRecord(responseData, 'repository', 'data');
		const pullRequest = getRecord(repository, 'pullRequest', 'repository');
		const reviewThreads = getRecord(pullRequest, 'reviewThreads', 'pullRequest');
		const pageInfo = parsePageInfo(reviewThreads.pageInfo, 'reviewThreads');
		const nodes = getArray(reviewThreads, 'nodes', 'reviewThreads');

		for (const [threadIndex, node] of nodes.entries()) {
			if (!isRecord(node)) {
				throw new Error(`Unexpected review thread format at index ${threadIndex}.`);
			}
			if (typeof node.id !== 'string') {
				throw new Error(`Unexpected review thread format at index ${threadIndex}: missing id.`);
			}

			const isResolved = node.isResolved === true;
			const thread: ReviewThreadLocation = {
				id: node.id,
				path: typeof node.path === 'string' ? node.path : '',
				line: typeof node.line === 'number' ? node.line : null,
				original_line: typeof node.originalLine === 'number' ? node.originalLine : null,
			};
			const comments = getRecord(node, 'comments', `reviewThreads.nodes[${threadIndex}]`);
			const commentsPageInfo = parsePageInfo(comments.pageInfo, `reviewThreads.nodes[${threadIndex}].comments`);
			const commentNodes = getArray(comments, 'nodes', `reviewThreads.nodes[${threadIndex}].comments`);

			const threadCopilotComments: ReviewThreadComment[] = [];
			for (const [commentIndex, commentNode] of commentNodes.entries()) {
				const parsed = parseReviewThreadComment(commentNode, thread, `reviewThreads.nodes[${threadIndex}].comments.nodes[${commentIndex}]`);
				if (parsed !== undefined) {
					threadCopilotComments.push(parsed);
				}
			}
			if (commentsPageInfo.hasNextPage && commentsPageInfo.endCursor !== null) {
				threadCopilotComments.push(...await getAdditionalReviewThreadComments(thread, commentsPageInfo.endCursor));
			}

			if (threadCopilotComments.length === 0) {
				// Not a Copilot-authored thread; ignore it.
				continue;
			}

			if (isResolved) {
				resolvedCopilotThreadCount++;
			} else {
				unresolved.push(...threadCopilotComments);
			}
		}

		after = pageInfo.hasNextPage && pageInfo.endCursor !== null ? pageInfo.endCursor : undefined;
	} while (after !== undefined);

	return { unresolved, resolvedCopilotThreadCount };
}

function isCopilotLogin(login: string): boolean {
	return login.toLowerCase().includes('copilot');
}

function isCompletedCopilotReview(review: Review): boolean {
	return isCopilotLogin(review.user.login) && review.submitted_at.length > 0 && review.state.toUpperCase() !== 'PENDING';
}

function formatLineRange(comment: ReviewComment): string {
	const end = comment.line ?? comment.original_line;
	const start = comment.start_line;
	if (end === null) {
		return '(location unknown)';
	}
	if (start !== null && start !== end) {
		return `L${start}-L${end}`;
	}
	return `L${end}`;
}

function formatReviewThreadLineRange(comment: ReviewThreadComment): string {
	const end = comment.line ?? comment.original_line;
	if (end === null) {
		return '(location unknown)';
	}
	return `L${end}`;
}

function indent(text: string, prefix: string): string {
	return text.split('\n').map(line => prefix + line).join('\n');
}

function printPrInfo(info: PrInfo): void {
	console.log('PR details:');
	console.log(`  #${info.number} ${info.title}`);
	console.log(`  ${info.url}`);
	console.log(`  ${info.headRefName} -> ${info.baseRefName}`);
	console.log('');
}

function printReviewComments(comments: ReviewComment[]): void {
	if (comments.length === 0) {
		console.log('(No inline review comments were produced.)');
		return;
	}

	console.log('Comments:');
	console.log('');
	for (const comment of comments) {
		console.log(`- ${comment.path}:${formatLineRange(comment)} by ${comment.user.login}`);
		console.log(indent(comment.body.trim(), '  '));
		console.log('');
	}
}

function printReviewThreadComments(comments: ReviewThreadComment[]): void {
	for (const comment of comments) {
		console.log(`- ${comment.path}:${formatReviewThreadLineRange(comment)} by ${comment.user.login} @ ${comment.created_at}`);
		console.log(indent(comment.body.trim(), '  '));
		console.log('');
	}
}

async function main(): Promise<void> {
	const [prNumber, repo] = process.argv.slice(2);
	if (!prNumber || !repo) {
		usage();
	}

	let prInfo: PrInfo;
	try {
		prInfo = await getPrInfo(prNumber, repo);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.log('');
		console.log('RESULT: COPILOT_REVIEW_ERROR');
		process.exit(2);
	}

	printPrInfo(prInfo);

	let initialReviews: Review[];
	try {
		initialReviews = (await getReviews(prNumber, repo)).filter(isCompletedCopilotReview);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.log('');
		console.log('RESULT: COPILOT_REVIEW_ERROR');
		process.exit(2);
	}

	// Track all known review IDs so a new review submitted after monitoring
	// starts is detected as "new".
	const initialReviewIds = new Set(initialReviews.map(r => r.id));

	let initialThreadState: CopilotReviewThreadState;
	try {
		initialThreadState = await getCopilotReviewThreadState(prNumber, repo);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.log('');
		console.log('RESULT: COPILOT_REVIEW_ERROR');
		process.exit(2);
	}

	if (initialThreadState.unresolved.length > 0) {
		console.log('RESULT: UNRESOLVED_COPILOT_REVIEW_COMMENTS');
		console.log(`UNRESOLVED_COMMENT_COUNT: ${initialThreadState.unresolved.length}`);
		console.log('');
		console.log('Unresolved Copilot comments:');
		console.log('');
		printReviewThreadComments(initialThreadState.unresolved);
		process.exit(0);
	}

	const hasReviewForHead = initialReviews.some(review => review.commit_id === prInfo.headRefOid);
	let expectation: CopilotReviewExpectation;
	try {
		const [hasExplicitRequest, rule] = await Promise.all([
			hasExplicitCopilotReviewRequest(prNumber, repo),
			getCopilotReviewRule(repo, prInfo.baseRefName),
		]);
		expectation = evaluateCopilotReviewExpectation(
			repo,
			prInfo.isDraft,
			hasExplicitRequest,
			rule,
			initialReviews.length,
			hasReviewForHead,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.log('');
		console.log('RESULT: COPILOT_REVIEW_ERROR');
		process.exit(2);
	}

	if (!expectation.expected) {
		console.log('RESULT: NO_COPILOT_REVIEW_EXPECTED');
		console.log(`REASON: ${expectation.reason}`);
		console.log('');
		console.log('(The monitor is exiting without waiting. Personal automatic-review settings are not exposed by the GitHub API.)');
		process.exit(0);
	}

	const deadline = Date.now() + copilotReviewWaitTimeoutMs;
	console.log(`Waiting for Copilot review on PR #${prNumber} (${repo})...`);
	console.log(`Review expected because ${expectation.reason}.`);
	console.log(`Monitoring for up to ${copilotReviewWaitTimeoutMs / 60_000} minutes; an absent requested reviewer will not end the wait.`);

	while (true) {
		const remainingMs = deadline - Date.now();
		if (remainingMs > 0) {
			await setTimeout(Math.min(pollIntervalMs, remainingMs));
		}

		console.log(`--- Checking Copilot review at ${new Date().toString()} ---`);
		let currentThreadState: CopilotReviewThreadState;
		let currentReviews: Review[];
		try {
			[currentThreadState, currentReviews] = await Promise.all([
				getCopilotReviewThreadState(prNumber, repo),
				getReviews(prNumber, repo).then(reviews => reviews.filter(isCompletedCopilotReview)),
			]);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			console.log('');
			console.log('RESULT: COPILOT_REVIEW_ERROR');
			process.exit(2);
		}

		const newReviews = currentReviews.filter(r => !initialReviewIds.has(r.id));
		const outcome = evaluateCopilotReviewPoll({
			unresolvedCommentCount: currentThreadState.unresolved.length,
			newReviewCount: newReviews.length,
			deadlineReached: Date.now() >= deadline,
		});

		if (outcome === 'comments') {
			console.log('');
			console.log('RESULT: NEW_COPILOT_REVIEW');
			console.log(`NEW_REVIEW_COUNT: ${newReviews.length}`);
			console.log(`NEW_COMMENT_COUNT: ${currentThreadState.unresolved.length}`);
			console.log('');
			console.log('Comments:');
			console.log('');
			printReviewThreadComments(currentThreadState.unresolved);
			process.exit(0);
		}

		if (outcome === 'review') {
			let allComments: ReviewComment[] = [];
			try {
				allComments = await getReviewComments(prNumber, repo);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				console.log('');
				console.log('RESULT: COPILOT_REVIEW_ERROR');
				process.exit(2);
			}

			const newReviewIdSet = new Set(newReviews.map(r => r.id));
			const newComments = allComments.filter(c => c.pull_request_review_id !== null && newReviewIdSet.has(c.pull_request_review_id));

			console.log('');
			console.log('RESULT: NEW_COPILOT_REVIEW');
			console.log(`NEW_REVIEW_COUNT: ${newReviews.length}`);
			console.log(`NEW_COMMENT_COUNT: ${newComments.length}`);
			console.log('');

			printReviewComments(newComments);
			process.exit(0);
		}

		if (outcome === 'timeout') {
			console.log('');
			console.log('RESULT: COPILOT_REVIEW_TIMEOUT');
			console.log(`EXISTING_REVIEW_COUNT: ${initialReviews.length}`);
			console.log(`EXISTING_COMMENT_COUNT: 0`);
			console.log('');
			console.log(`(No new Copilot review or unresolved Copilot comments appeared within ${copilotReviewWaitTimeoutMs / 60_000} minutes.)`);
			process.exit(0);
		}

		console.log('Still waiting for a new Copilot review or unresolved Copilot comments...');
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
