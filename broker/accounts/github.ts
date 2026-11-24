/** GitHub through its REST API: reading repositories, issues, pull requests and releases, and changes a person reviewed. */
import { asker, clip, type Credentials, type Identity, type WriteContext, type Written } from './adapter.ts';

export type GitHubWrite =
  | { kind: 'issue.create'; repo: string; title: string; body: string; labels: string[] }
  | { kind: 'issue.update'; repo: string; number: number; title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[]; revision: string }
  | { kind: 'comment'; repo: string; number: number; body: string }
  | { kind: 'pull.create'; repo: string; title: string; body: string; head: string; base: string; draft: boolean }
  | { kind: 'release.draft'; repo: string; tag: string; target?: string; name: string; body: string };
const limits = { body: 60_000, patch: 4000, files: 100, comments: 50, file: 200_000 };
export function repository(value: unknown) { if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value) || /\/\.{1,2}$/.test(value)) throw new Error('Name a repository as owner/name'); return value; }
const number = (value: unknown) => { if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1e9) throw new Error('Give the issue or pull request number'); return value as number; };
const ref = (value: unknown, what: string) => { if (typeof value !== 'string' || !value || value.length > 250 || /[\x00-\x20~^:?*[\\\x7f]|\.\.|@\{|^\/|\/$|^-/.test(value)) throw new Error(`Give ${what} as a branch, tag or commit`); return value; };
const line = (value: unknown, what: string, max = 250) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Give ${what} on one line (up to ${max} characters)`); return value.trim(); };
const text = (value: unknown, what: string, required = false) => { if (value === undefined || value === null) value = ''; if (typeof value !== 'string' || value.length > limits.body || required && !value.trim()) throw new Error(`Write ${what} (up to ${limits.body.toLocaleString('en')} characters)`); return value; };
const labels = (value: unknown) => { if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 50)) throw new Error('List up to 20 labels'); return value.map((item: string) => item.trim()); };
export function validWrite(p: any): GitHubWrite {
  const repo = repository(p?.repo);
  switch (p?.kind) {
    case 'issue.create': return { kind: p.kind, repo, title: line(p.title, 'a title'), body: text(p.body, 'the issue'), labels: labels(p.labels ?? []) };
    case 'issue.update': {
      const changes = { ...(p.title !== undefined ? { title: line(p.title, 'a title') } : {}), ...(p.body !== undefined ? { body: text(p.body, 'the text') } : {}), ...(p.state !== undefined ? { state: ['open', 'closed'].includes(p.state) ? p.state : (() => { throw new Error('An issue is open or closed'); })() } : {}), ...(p.labels !== undefined ? { labels: labels(p.labels) } : {}) };
      if (!Object.keys(changes).length) throw new Error('Choose what to change');
      if (typeof p.revision !== 'string' || !p.revision) throw new Error('Read the issue first, then change it');
      return { kind: p.kind, repo, number: number(p.number), ...changes, revision: p.revision };
    }
    case 'comment': return { kind: p.kind, repo, number: number(p.number), body: text(p.body, 'the comment', true) };
    case 'pull.create': return { kind: p.kind, repo, title: line(p.title, 'a title'), body: text(p.body, 'the description'), head: ref(p.head, 'the branch with the changes'), base: ref(p.base, 'the branch to merge into'), draft: p.draft === true };
    case 'release.draft': return { kind: p.kind, repo, tag: ref(p.tag, 'the tag'), ...(p.target ? { target: ref(p.target, 'the target') } : {}), name: line(p.name || p.tag, 'a name'), body: text(p.body, 'the notes') };
    default: throw new Error('Choose what to write on GitHub');
  }
}
/** What will be written, in full, as the person reviews it. */
export function describeWrite(write: GitHubWrite) {
  const body = 'body' in write && write.body ? `\n\n${write.body}` : '';
  switch (write.kind) {
    case 'issue.create': return `New issue in ${write.repo}\nTitle: ${write.title}${write.labels.length ? `\nLabels: ${write.labels.join(', ')}` : ''}${body}`;
    case 'issue.update': return `Change ${write.repo}#${write.number}${write.title !== undefined ? `\nTitle: ${write.title}` : ''}${write.state ? `\nState: ${write.state}` : ''}${write.labels ? `\nLabels: ${write.labels.join(', ') || 'none'}` : ''}${write.body !== undefined ? `\nNew text:\n\n${write.body}` : ''}`;
    case 'comment': return `Comment on ${write.repo}#${write.number}${body}`;
    case 'pull.create': return `${write.draft ? 'Draft pull' : 'Pull'} request in ${write.repo}\n${write.head} → ${write.base}\nTitle: ${write.title}${body}`;
    case 'release.draft': return `Draft release ${write.tag} in ${write.repo} (not published)${write.target ? `\nTarget: ${write.target}` : ''}\nName: ${write.name}${body}`;
  }
}

export class GitHub {
  private api: string; private ask: ReturnType<typeof asker>; private http: Credentials['http']; private credentials: Credentials;
  constructor(credentials: Credentials, api: string) { this.credentials = credentials; this.http = credentials.http; this.api = api; this.ask = asker(credentials); }
  private get<T = any>(path: string, params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) {
    const url = new URL(this.api + path); for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    return this.ask<T>({ url: url.href, headers: this.headers, ...(signal ? { signal } : {}) }).then(reply => reply.value);
  }
  private put<T = any>(method: 'POST' | 'PATCH', path: string, json: unknown, signal?: AbortSignal) { return this.ask<T>({ method, url: this.api + path, json, headers: this.headers, ...(signal ? { signal } : {}) }).then(reply => reply.value); }
  private headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async identity(signal?: AbortSignal): Promise<Identity> { const me = await this.get('/user', {}, signal); return { subject: String(me.id), login: String(me.login) }; }
  async search(kind: 'repositories' | 'code' | 'issues' | 'pulls', query: string, limit: number, signal?: AbortSignal) {
    const q = kind === 'pulls' ? `${query} is:pr` : kind === 'issues' ? `${query} is:issue` : query, value = await this.get(`/search/${kind === 'pulls' ? 'issues' : kind}`, { q, per_page: limit }, signal);
    const items = (value.items || []).slice(0, limit).map((item: any) => kind === 'repositories' ? { repo: item.full_name, description: clip(item.description, 300).text, language: item.language || undefined, stars: item.stargazers_count, private: item.private === true, updated: item.updated_at, link: item.html_url }
      : kind === 'code' ? { repo: item.repository?.full_name, path: item.path, link: item.html_url } : { repo: String(item.repository_url || '').split('/').slice(-2).join('/'), number: item.number, title: clip(item.title, 300).text, state: item.state, author: item.user?.login, updated: item.updated_at, comments: item.comments, link: item.html_url });
    return { total: Number(value.total_count) || items.length, items, ...(value.incomplete_results ? { incomplete: true } : {}) };
  }
  async repo(name: string, signal?: AbortSignal) { const r = await this.get(`/repos/${repository(name)}`, {}, signal); return { repo: r.full_name, description: clip(r.description, 500).text, defaultBranch: r.default_branch, private: r.private === true, archived: r.archived === true, openIssues: r.open_issues_count, license: r.license?.spdx_id || undefined, topics: r.topics || [], updated: r.pushed_at, link: r.html_url }; }
  /** A file's text, or what a folder holds. */
  async contents(name: string, path: string, at: string | undefined, signal?: AbortSignal) {
    const clean = path.split('/').filter(Boolean); if (clean.some(part => part === '.' || part === '..')) throw new Error('Give a path inside the repository');
    const value = await this.get(`/repos/${repository(name)}/contents/${clean.map(encodeURIComponent).join('/')}`, { ref: at && ref(at, 'the version') }, signal);
    if (Array.isArray(value)) return { repo: name, path: clean.join('/'), entries: value.slice(0, 300).map((item: any) => ({ name: item.name, kind: item.type === 'dir' ? 'folder' : item.type, bytes: item.size })), total: value.length };
    const bytes = value.content && value.encoding === 'base64' ? Buffer.from(value.content, 'base64') : (await this.http.raw({ url: `${this.api}/repos/${name}/contents/${clean.map(encodeURIComponent).join('/')}${at ? `?ref=${encodeURIComponent(at)}` : ''}`, token: await this.credentials.token(signal), headers: { ...this.headers, Accept: 'application/vnd.github.raw+json' }, maxBytes: 20 * 1024 * 1024, ...(signal ? { signal } : {}) })).body;
    const binary = bytes.subarray(0, 8000).includes(0);
    return { repo: name, path: value.path, sha: value.sha, bytes: bytes.length, link: value.html_url, ...(binary ? { binary: true } : clip(bytes.toString('utf8'), limits.file)), data: bytes };
  }
  async issue(name: string, n: number, signal?: AbortSignal) {
    const base = `/repos/${repository(name)}/issues/${number(n)}`, issue = await this.get(base, {}, signal), comments = issue.comments ? await this.get(`${base}/comments`, { per_page: limits.comments }, signal) : [];
    return { repo: name, number: issue.number, kind: issue.pull_request ? 'pull request' : 'issue', title: issue.title, state: issue.state, author: issue.user?.login, created: issue.created_at, revision: issue.updated_at, labels: (issue.labels || []).map((item: any) => item.name || item), assignees: (issue.assignees || []).map((item: any) => item.login), body: clip(issue.body, 30_000).text, link: issue.html_url,
      comments: comments.map((item: any) => ({ author: item.user?.login, at: item.created_at, body: clip(item.body, 8000).text })), ...(issue.comments > limits.comments ? { moreComments: issue.comments - limits.comments } : {}) };
  }
  async pull(name: string, n: number, signal?: AbortSignal) {
    const base = `/repos/${repository(name)}/pulls/${number(n)}`, pull = await this.get(base, {}, signal), [files, reviews, checks] = await Promise.all([this.get(`${base}/files`, { per_page: limits.files }, signal), this.get(`${base}/reviews`, { per_page: 30 }, signal).catch(() => []), this.get(`/repos/${name}/commits/${pull.head?.sha}/check-runs`, { per_page: 50 }, signal).catch(() => ({ check_runs: [] }))]);
    return { repo: name, number: pull.number, title: pull.title, state: pull.merged ? 'merged' : pull.state, draft: pull.draft === true, author: pull.user?.login, revision: pull.updated_at, head: pull.head?.ref, base: pull.base?.ref, mergeable: pull.mergeable_state, body: clip(pull.body, 30_000).text, link: pull.html_url, additions: pull.additions, deletions: pull.deletions, changedFiles: pull.changed_files,
      files: files.map((file: any) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, ...(file.patch ? { patch: clip(file.patch, limits.patch).text, ...(file.patch.length > limits.patch ? { patchCut: true } : {}) } : {}) })),
      reviews: reviews.map((item: any) => ({ author: item.user?.login, state: item.state, body: clip(item.body, 2000).text })), checks: (checks.check_runs || []).map((item: any) => ({ name: item.name, status: item.status, result: item.conclusion || undefined })) };
  }
  async releases(name: string, signal?: AbortSignal) { return (await this.get(`/repos/${repository(name)}/releases`, { per_page: 20 }, signal)).map((item: any) => ({ tag: item.tag_name, name: item.name, draft: item.draft === true, prerelease: item.prerelease === true, published: item.published_at, body: clip(item.body, 4000).text, link: item.html_url })); }
  /** The commits and files between two versions, for preparing a change or a release. */
  async compare(name: string, base: string, head: string, signal?: AbortSignal) {
    const value = await this.get(`/repos/${repository(name)}/compare/${encodeURIComponent(ref(base, 'the first version'))}...${encodeURIComponent(ref(head, 'the second version'))}`, { per_page: 100 }, signal);
    return { repo: name, base, head, ahead: value.ahead_by, behind: value.behind_by, commits: (value.commits || []).map((item: any) => ({ sha: String(item.sha).slice(0, 12), message: clip(item.commit?.message, 1000).text, author: item.author?.login || item.commit?.author?.name })), files: (value.files || []).slice(0, 200).map((file: any) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions })), link: value.html_url };
  }
  async write(p: GitHubWrite, context: WriteContext): Promise<Written> {
    const at = `/repos/${p.repo}`, done = (value: any): Written => ({ id: String(value.number ?? value.id), link: value.html_url, ...(value.updated_at ? { revision: value.updated_at } : {}) });
    switch (p.kind) {
      case 'issue.create': return done(await this.put('POST', `${at}/issues`, { title: p.title, body: p.body, ...(p.labels.length ? { labels: p.labels } : {}) }, context.signal));
      case 'issue.update': {
        const now = await this.get(`${at}/issues/${p.number}`, {}, context.signal); if (now.updated_at !== p.revision) throw new Error('This issue changed since it was read. Read it again before changing it.');
        const { kind: _kind, repo: _repo, number: n, revision: _revision, ...changes } = p; return done(await this.put('PATCH', `${at}/issues/${n}`, changes, context.signal));
      }
      case 'comment': return done(await this.put('POST', `${at}/issues/${p.number}/comments`, { body: p.body }, context.signal));
      case 'pull.create': return done(await this.put('POST', `${at}/pulls`, { title: p.title, body: p.body, head: p.head, base: p.base, draft: p.draft }, context.signal));
      case 'release.draft': return done(await this.put('POST', `${at}/releases`, { tag_name: p.tag, ...(p.target ? { target_commitish: p.target } : {}), name: p.name, body: p.body, draft: true }, context.signal));
    }
  }
  /** Whether a write whose answer was lost took effect: the same content, by this account, since it was sent. */
  async written(p: GitHubWrite, login: string, context: WriteContext): Promise<Written | undefined> {
    const at = `/repos/${p.repo}`, since = new Date(context.started - 60_000).toISOString(), same = (a: unknown, b: unknown) => String(a ?? '').replace(/\r\n/g, '\n') === String(b ?? '').replace(/\r\n/g, '\n'), done = (value: any): Written => ({ id: String(value.number ?? value.id), link: value.html_url });
    const recent = (value: any) => Date.parse(value.created_at) >= context.started - 60_000;
    if (p.kind === 'issue.create') { const found = (await this.get(`${at}/issues`, { creator: login, state: 'all', since, per_page: 30 }, context.signal)).find((item: any) => !item.pull_request && recent(item) && item.title === p.title && same(item.body, p.body)); return found && done(found); }
    if (p.kind === 'comment') { const found = (await this.get(`${at}/issues/${p.number}/comments`, { since, per_page: 100 }, context.signal)).find((item: any) => item.user?.login === login && recent(item) && same(item.body, p.body)); return found && done(found); }
    if (p.kind === 'pull.create') { const owner = p.repo.split('/')[0], found = (await this.get(`${at}/pulls`, { head: p.head.includes(':') ? p.head : `${owner}:${p.head}`, base: p.base, state: 'all', per_page: 10 }, context.signal)).find((item: any) => recent(item) && item.title === p.title); return found && done(found); }
    if (p.kind === 'release.draft') { const found = (await this.get(`${at}/releases`, { per_page: 20 }, context.signal)).find((item: any) => item.draft && item.tag_name === p.tag && item.name === p.name); return found && done(found); }
    const now = await this.get(`${at}/issues/${p.number}`, {}, context.signal);
    return (p.title === undefined || now.title === p.title) && (p.body === undefined || same(now.body, p.body)) && (p.state === undefined || now.state === p.state) && (p.labels === undefined || JSON.stringify((now.labels || []).map((item: any) => item.name).sort()) === JSON.stringify([...p.labels].sort())) ? done(now) : undefined;
  }
}
