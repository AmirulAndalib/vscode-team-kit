import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

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
 *   2. Otherwise, check whether Copilot is currently listed in the PR's
 *      pending reviewers. GitHub adds Copilot there when a review is
 *      requested and removes it once Copilot submits its review, so this
 *      is the signal for "a review is actively in flight". Because GitHub
 *      sometimes takes a moment to register the reviewer after PR
 *      creation, we retry the check once after a short grace window.
 *        - Not pending after grace -> nothing to wait for, exit with
 *          `NO_PENDING_COPILOT_REVIEW`.
 *        - Pending -> enter the polling loop.
 *
 *   3. Polling loop (every `pollIntervalMs`):
 *        a. Re-fetch completed Copilot reviews. Any review whose ID was not
 *           present at startup is a new review -> exit with
 *           `NEW_COPILOT_REVIEW` and print each inline comment on it.
 *        b. Re-check the pending reviewers list. If Copilot has dropped out
 *           *and* no new review showed up, the request was cancelled or
 *           withdrawn -> exit with `NO_PENDING_COPILOT_REVIEW`.
 *
 * The script deliberately avoids using resolved/unresolved comment counts or
 * commit SHAs to decide whether to wait — amends, rebases, and squash-merges
 * make those signals unreliable. Presence in the pending reviewers list is
 * the single source of truth for "Copilot is working on a review right now".
 *
 * Any unexpected `gh` or GraphQL failure prints the error and exits with
 * `COPILOT_REVIEW_ERROR` (exit code 2).
 */

const pollIntervalMs = 30_000;

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
	baseRefName: string;
}

interface Review {
	id: number;
	user: { login: string };
	state: string;
	submitted_at: string;
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
		'--json', 'number,title,url,headRefName,baseRefName',
	]);
	if (!isRecord(data)) {
		throw new Error('Unexpected response from gh pr view.');
	}
	return {
		number: typeof data.number === 'number' ? data.number : Number(data.number),
		title: typeof data.title === 'string' ? data.title : '',
		url: typeof data.url === 'string' ? data.url : '',
		headRefName: typeof data.headRefName === 'string' ? data.headRefName : '',
		baseRefName: typeof data.baseRefName === 'string' ? data.baseRefName : '',
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
		};
	});
}

/**
 * Returns true if Copilot is currently listed as a pending reviewer on the PR.
 *
 * GitHub places a reviewer in `requested_reviewers` when a review is
 * requested and removes them once the review is submitted. For Copilot this
 * produces a window of a few minutes (between "Copilot review requested" and
 * "Copilot finishes and posts its review") during which this function
 * returns true.
 */
async function isCopilotPendingReviewer(prNumber: string, repo: string): Promise<boolean> {
	const data = await ghJson([
		'api', `repos/${repo}/pulls/${prNumber}`,
	]);
	if (!isRecord(data)) {
		throw new Error('Unexpected response from gh api pulls/<n>.');
	}
	const requested = data.requested_reviewers;
	if (!Array.isArray(requested)) {
		return false;
	}
	for (const entry of requested) {
		if (isRecord(entry) && typeof entry.login === 'string' && isCopilotLogin(entry.login)) {
			return true;
		}
	}
	return false;
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
		for (const comment of initialThreadState.unresolved) {
			console.log(`- ${comment.path}:${formatReviewThreadLineRange(comment)} by ${comment.user.login} @ ${comment.created_at}`);
			console.log(indent(comment.body.trim(), '  '));
			console.log('');
		}
		process.exit(0);
	}

	// Is Copilot currently processing a review request? This is the ONLY
	// signal we use to decide whether to wait — resolved comments or prior
	// completed reviews alone do not imply that a re-review is coming.
	let copilotPending: boolean;
	try {
		copilotPending = await isCopilotPendingReviewer(prNumber, repo);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.log('');
		console.log('RESULT: COPILOT_REVIEW_ERROR');
		process.exit(2);
	}

	// Grace window: immediately after `gh pr create`, GitHub may not yet
	// have registered Copilot as a pending reviewer. Retry once after a
	// short wait before concluding nothing is coming.
	if (!copilotPending) {
		console.log('Copilot is not yet in the pending reviewers list. Waiting one interval for the request to register...');
		await setTimeout(pollIntervalMs);
		try {
			copilotPending = await isCopilotPendingReviewer(prNumber, repo);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			console.log('');
			console.log('RESULT: COPILOT_REVIEW_ERROR');
			process.exit(2);
		}
	}

	if (!copilotPending) {
		// No pending Copilot review request. Nothing to wait for — whether or
		// not Copilot has reviewed this PR before, the user would need to
		// request a fresh review before this script has anything to do.
		console.log('RESULT: NO_PENDING_COPILOT_REVIEW');
		console.log(`EXISTING_REVIEW_COUNT: ${initialReviews.length}`);
		console.log(`EXISTING_COMMENT_COUNT: 0`);
		console.log('');
		if (initialReviews.length === 0) {
			console.log('(Copilot has not reviewed this PR, and no review is currently pending.)');
		} else {
			console.log('(Copilot has already reviewed this PR, and no re-review is currently pending.)');
		}
		process.exit(0);
	}

	console.log(`Waiting for Copilot review on PR #${prNumber} (${repo})...`);
	console.log('Copilot is currently in the PR\'s pending reviewers list.');

	while (true) {
		let currentReviews: Review[];
		try {
			currentReviews = (await getReviews(prNumber, repo)).filter(isCompletedCopilotReview);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			console.log('');
			console.log('RESULT: COPILOT_REVIEW_ERROR');
			process.exit(2);
		}

		const newReviews = currentReviews.filter(r => !initialReviewIds.has(r.id));
		if (newReviews.length > 0) {
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

		// No new review yet. If Copilot has also left the pending reviewers
		// list, the request was cancelled or withdrawn and nothing is coming.
		// (Order matters: we fetched reviews *before* pending status, so a
		// review that landed between the two fetches would still have been
		// picked up above.)
		let stillPending: boolean;
		try {
			stillPending = await isCopilotPendingReviewer(prNumber, repo);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			console.log('');
			console.log('RESULT: COPILOT_REVIEW_ERROR');
			process.exit(2);
		}

		if (!stillPending) {
			console.log('');
			console.log('Copilot is no longer in the PR\'s pending reviewers list and no new review was submitted.');
			console.log('RESULT: NO_PENDING_COPILOT_REVIEW');
			console.log(`EXISTING_REVIEW_COUNT: ${initialReviews.length}`);
			console.log(`EXISTING_COMMENT_COUNT: 0`);
			console.log('');
			console.log('(The Copilot review request appears to have been cancelled.)');
			process.exit(0);
		}

		await setTimeout(pollIntervalMs);
	}
}

await main();
