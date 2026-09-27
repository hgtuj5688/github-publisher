/**
 * GitHub publisher — client half.
 *
 * Adds a 「发布 GitHub」 control to the left of the composer tool row. It reads
 * this session's own transcript from the Trajectory snapshot, shows the exact
 * text it is about to publish, and posts it to the host half's same-origin API
 * (`/github-publisher/publish`), which writes the introduction with this
 * session's model and creates the gist.
 *
 * Plain JavaScript only: this file is served to the browser as-is.
 */
window.__ModuleLoader__.load({
  id: '@local/github-publisher',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'github-publisher';
    const SLOT = 'conversation.input.left';
    const API = '/github-publisher';

    const zh = {
      button: '发布 GitHub',
      title: '发布到 GitHub',
      hint: '正文是本会话的完整记录，可直接编辑；发布为 GitHub 仓库中的一次提交。',
      source: '来源',
      sourceSession: '重读整个会话',
      sourceManual: '手动',
      sessionRange: '本会话 {part}/{total} 条消息',
      summaryLabel: '标题（可选，帮助模型写好简介）',
      summaryPlaceholder: '这段总结是什么？例如：DSH 插件开发笔记',
      contentLabel: '要发布的内容',
      contentPlaceholder: '这会话的全部记录会填在这里，也可以直接粘贴别的内容',
      introNote: '未填写简介时，由本会话的模型自动撰写提交说明。',
      publicLabel: '公开仓库',
      cancel: '取消',
      localIntro: '模型不可用，简介取自正文首行',
      cdnLink: '国内可读直链',
      copied: '直链已复制',
      publish: '发布',
      working: '正在撰写简介并发布…',
      empty: '没有可发布的内容：先选一段回复，或在输入框里粘贴内容。',
      done: '已发布',
      failed: '发布失败',
      unknownError: '未知错误',
    };
    const en = {
      button: 'Publish to GitHub',
      title: 'Publish to GitHub',
      hint: 'The text is this session’s complete record, and can be edited; it is published as one commit in a GitHub repository.',
      source: 'Source',
      sourceSession: 're-read whole session',
      sourceManual: 'manual',
      sessionRange: 'session {part}/{total} messages',
      summaryLabel: 'Title (optional; helps the model write a good intro)',
      summaryPlaceholder: 'What is this summary? For example: DSH plugin notes',
      contentLabel: 'Content to publish',
      contentPlaceholder: 'This session’s whole record is filled in here; you can also paste something else',
      introNote: "With no description, this session's model writes the commit message.",
      publicLabel: 'Public repository',
      cancel: 'Cancel',
      localIntro: 'model unavailable — intro taken from the first line',
      cdnLink: 'China-readable link',
      copied: 'link copied',
      publish: 'Publish',
      working: 'Writing the introduction and publishing…',
      empty: 'Nothing to publish: pick a reply, or paste content into the box.',
      done: 'Published',
      failed: 'Publish failed',
      unknownError: 'unknown error',
    };

    const CSS = [
      '.ghp-root{position:relative;display:inline-flex}',
      '.ghp-button{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
      '.ghp-button:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.ghp-button[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.ghp-button:disabled{opacity:.5;cursor:default}',
      '.ghp-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);display:block}',
      '.ghp-dot.on{background:var(--dsw-alias-state-success-primary)}',
      '.ghp-panel{position:absolute;bottom:calc(100% + 8px);left:0;z-index:40;width:420px;max-width:min(90vw,420px);padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:12px}',
      '.ghp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px}',
      '.ghp-title{font-weight:600;font-size:13px}',
      '.ghp-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1}',
      '.ghp-hint{color:var(--dsw-alias-label-secondary);margin-bottom:8px}',
      '.ghp-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}',
      '.ghp-label{color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.ghp-select,.ghp-input{flex:1 1 auto;min-width:0;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}',
      '.ghp-field{display:block;color:var(--dsw-alias-label-secondary);margin:6px 0 4px}',
      '.ghp-textarea{width:100%;height:150px;resize:vertical;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.45}',
      '.ghp-check{display:flex;align-items:center;gap:6px;margin-top:8px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-count{flex:1 1 auto;text-align:right;color:var(--dsw-alias-label-secondary)}',
      '.ghp-note{margin-top:6px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px}',
      '.ghp-ghost{padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
      '.ghp-primary{padding:6px 12px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-brand-primary);color:#fff;font:inherit;cursor:pointer}',
      '.ghp-primary:disabled{opacity:.5;cursor:default}',
      '.ghp-status{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}',
      '.ghp-error{color:var(--dsw-alias-state-error-primary)}',
      '.ghp-ok{color:var(--dsw-alias-state-success-primary)}',
      '.ghp-link{color:var(--dsw-alias-brand-primary);cursor:pointer;background:none;border:0;padding:0;font:inherit;text-decoration:underline}',
    ].join('');

    /**
     * Turn one AssistantBlock into its text, when it carries any.
     * @param {any} block - an assistant block.
     * @returns {string} the text, or an empty string.
     */
    function blockText(block) {
      if (block === null || typeof block !== 'object') return '';
      if (typeof block.text === 'string' && (block.kind === 'text' || block.kind === undefined)) return block.text;
      return '';
    }

    /**
     * Concatenate the text blocks of one message node.
     * @param {any} node - a conversation node.
     * @returns {string} the joined text.
     */
    function nodeText(node) {
      if (node === null || typeof node !== 'object') return '';
      const source = Array.isArray(node.blocks) ? node.blocks : Array.isArray(node.content) ? node.content : [];
      const parts = [];
      for (const block of source) {
        const value = blockText(block);
        if (value.trim().length > 0) parts.push(value.trim());
      }
      return parts.join('\n\n').trim();
    }

    /** Character budget for one transcript draft, kept below the host's body limit. */
    const SESSION_CHAR_BUDGET = 60_000;

    /**
     * Render one node as a titled section.
     * @param {{title: string, text: string}} entry - the section.
     * @returns {string} the markdown section.
     */
    function renderEntry(entry) {
      return `### ${entry.title}\n\n${entry.text}`;
    }

    /**
     * Build the draft from the WHOLE session, not just the latest exchange: every
     * user and assistant message in order. The newest messages are kept when the
     * record is larger than the budget, because the end of a session carries the
     * conclusions.
     * @param {readonly any[]} eventNodes - the Trajectory event nodes.
     * @returns {{text: string, included: number, total: number}} the transcript.
     */
    function sessionTranscript(eventNodes) {
      if (!Array.isArray(eventNodes)) return { text: '', included: 0, total: 0 };
      const entries = [];
      let total = 0;
      for (const node of eventNodes) {
        if (node === null || typeof node !== 'object') continue;
        const speaker = node.kind === 'assistant'
          ? '回复'
          : node.kind === 'user' || node.kind === 'steering' ? '我的要求' : null;
        if (speaker === null) continue;
        const value = nodeText(node);
        if (value.length === 0) continue;
        total += 1;
        entries.push({ title: `${speaker} ${total}`, text: value });
      }
      let included = 0;
      let text = '';
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const candidate = renderEntry(entries[index]);
        const joined = text.length === 0 ? candidate : `${candidate}\n\n${text}`;
        if (joined.length > SESSION_CHAR_BUDGET && text.length > 0) break;
        text = joined;
        included += 1;
      }
      return { text, included, total };
    }

    /**
     * Turn a transcript into the publishable document.
     * @param {{text: string, included: number, total: number}} transcript - the transcript.
     * @returns {string} the document body.
     */
    function composeDocument(transcript) {
      const body = (transcript.text ?? '').trim();
      if (body.length === 0) return '';
      const header = '# 会话记录\n\n';
      if (transcript.included < transcript.total) {
        return `${header}> 共 ${transcript.total} 条消息，这里保留了最后 ${transcript.included} 条。\n\n${body}`;
      }
      return `${header}${body}`;
    }

    /**
     * Copy one link to the clipboard, falling back to opening it when the
     * browser denies clipboard access (an insecure origin, for example).
     * @param {string} value - the text to copy.
     * @param {string} text - the confirmation line to show once copied.
     * @param {(text: string) => void} confirm - reports the confirmation line.
     */
    function copyText(value, text, confirm) {
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
        Promise.resolve(clipboard.writeText(value)).then(() => {
          confirm(text);
        }).catch(() => {
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(value, '_blank', 'noopener');
        });
        return;
      }
      if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(value, '_blank', 'noopener');
    }

    /**
     * Call one endpoint of the host half's same-origin API.
     * @param {string} route - the endpoint below the mount point.
     * @param {RequestInit} [init] - fetch options.
     * @returns {Promise<Record<string, any>>} the decoded envelope.
     */
    async function call(route, init) {
      const response = await fetch(`${API}${route}`, init);
      const body = await response.text();
      let value;
      if (body.length > 0) {
        try {
          value = JSON.parse(body);
        } catch {
          value = undefined;
        }
      }
      if (value === null || typeof value !== 'object') {
        throw new Error(`the host answered ${String(response.status)} with an unreadable body`);
      }
      return value;
    }

    /**
     * Contain a render or effect crash below this boundary: an uncaught render
     * error retires the Slot entry for the rest of the page, which would remove
     * the button until a reload.
     * @returns {any} the boundary component.
     */
    function createBoundary() {
      if (typeof React.Component !== 'function') return null;
      class Boundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { failed: false };
        }
        static getDerivedStateFromError() {
          return { failed: true };
        }
        componentDidCatch(error) {
          if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn('[github-publisher] the composer button failed to render', error);
          }
        }
        render() {
          if (this.state.failed) return null;
          return this.props.children;
        }
      }
      return Boundary;
    }

    /**
     * Wrap a component in an error boundary. The wrapper renders the child as an
     * element (never by calling it as a function), so its hooks run on the
     * child's own fiber and survive the wrapper re-rendering.
     * @param {any} Boundary - the boundary component class.
     * @param {any} Child - the component to guard.
     * @returns {any} the guarded component.
     */
    function withBoundary(Boundary, Child) {
      return function GithubPublisherBoundary(props) {
        return h(Boundary, null, h(Child, props));
      };
    }

    /**
     * Build the composer button component.
     * @param {any} ctx - the client plugin context.
     * @param {(key: string) => string} t - the bound translator.
     * @returns {any} the component.
     */
    function createButton(ctx, t) {
      const Boundary = createBoundary();

      function Button(props) {
        const sessionId = props?.sessionId;
        const useTrajectory = typeof props?.useTrajectory === 'function' ? props.useTrajectory : null;
        const snap = useTrajectory === null ? null : useTrajectory((snapshot) => snapshot);
        const [open, setOpen] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [publishing, setPublishing] = React.useState(false);
        const [draft, setDraft] = React.useState(null);
        const [summary, setSummary] = React.useState('');
        // On by default: a secret gist never appears on the account's Gist page, so
        // a first publish looks like it went nowhere. Keeping one private stays possible.
        const [isPublic, setIsPublic] = React.useState(true);
        const [status, setStatus] = React.useState(null);
        const [account, setAccount] = React.useState(null);

        const ready = typeof sessionId === 'string' && sessionId.length > 0;

        React.useEffect(() => {
          if (!open || account !== null) return undefined;
          let live = true;
          Promise.resolve()
            .then(() => call('/status'))
            .then((value) => {
              if (live) setAccount(value);
            })
            .catch((error) => {
              if (live) setAccount({ ok: false, error: error instanceof Error ? error.message : String(error) });
            });
          return () => {
            live = false;
          };
        }, [open, account]);

        const transcript = React.useMemo(
          () => sessionTranscript(snap === null || snap === undefined ? [] : snap.eventNodes),
          [snap],
        );

        if (!ready) return null;

        /**
         * Open the panel, seeding the draft from this session the first time.
         * @returns {void}
         */
        const toggle = () => {
          setOpen((wasOpen) => {
            if (wasOpen) return false;
            setDraft((current) => (current === null ? composeDocument(transcript) : current));
            return true;
          });
        };

        /** Re-read the draft from the session. @returns {void} */
        const useSession = () => {
          setDraft(composeDocument(transcript));
          setStatus(null);
        };

        /**
         * Publish the draft through the host half.
         * @returns {Promise<void>} resolves once the attempt settled.
         */
        const publish = async () => {
          const content = (draft ?? '').trim();
          if (content.length === 0) {
            setStatus({ kind: 'error', text: t('empty') });
            return;
          }
          setPublishing(true);
          setStatus({ kind: 'info', text: t('working') });
          try {
            const value = await call('/publish', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                target: 'repo',
                content,
                summary: summary.trim(),
                private: !isPublic,
                language: String(document?.documentElement?.lang ?? '') || undefined,
              }),
            });
            if (value.ok === true) {
              const written = value.introSource === 'fallback' ? ` (${t('localIntro')})` : '';
              const first = Array.isArray(value.files) && value.files.length > 0 ? value.files[0] : null;
              setStatus({
                kind: 'done',
                text: `${t('done')} · ${String(value.intro ?? '')}${written}`,
                url: String(value.htmlUrl ?? ''),
                cdnUrl: typeof first?.cdnUrl === 'string' ? first.cdnUrl : '',
              });
            } else {
              setStatus({ kind: 'error', text: `${t('failed')} [${String(value.code ?? 'ERROR')}] ${String(value.error ?? t('unknownError'))}` });
            }
          } catch (error) {
            setStatus({ kind: 'error', text: `${t('failed')} ${error instanceof Error ? error.message : String(error)}` });
          } finally {
            setPublishing(false);
          }
        };

        const statusNode = status === null
          ? null
          : h('div', { className: `ghp-status${status.kind === 'error' ? ' ghp-error' : status.kind === 'done' ? ' ghp-ok' : ''}` },
            status.text,
            status.url === undefined || status.url.length === 0
              ? null
              : h('button', {
                type: 'button',
                className: 'ghp-link',
                onClick: () => {
                  if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(status.url, '_blank', 'noopener');
                },
              }, status.url),
            status.cdnUrl === undefined || status.cdnUrl.length === 0
              ? null
              : h('button', {
                type: 'button',
                className: 'ghp-link',
                title: t('cdnLink'),
                onClick: () => copyText(status.cdnUrl, `${status.text} · ${t('copied')}`, (line) => {
                  setStatus((current) => (current === null ? current : { ...current, text: line }));
                }),
              }, `${t('cdnLink')} ↗ ${String(status.cdnUrl)}`),
          );

        const panel = !open ? null : h('div', { className: 'ghp-panel', onMouseDown: (event) => event.stopPropagation() },
          h('div', { className: 'ghp-head' },
            h('span', { className: 'ghp-title' }, t('title')),
            h('button', { type: 'button', className: 'ghp-close', onClick: () => setOpen(false) }, '×'),
          ),
          h('div', { className: 'ghp-hint' }, t('hint')),
          h('div', { className: 'ghp-row' },
            h('span', { className: 'ghp-label' },
              account === null
                ? 'GitHub'
                : account.ok === true
                  ? `GitHub · ${String(account.login ?? '')} · ${String(account.defaultRepo ?? '')}`
                  : 'GitHub · ' + t('failed'),
            ),
          ),
          h('label', { className: 'ghp-field' }, t('summaryLabel')),
          h('input', {
            className: 'ghp-input',
            value: summary,
            placeholder: t('summaryPlaceholder'),
            onChange: (event) => setSummary(event.target.value),
          }),
          h('label', { className: 'ghp-field' }, t('contentLabel')),
          h('textarea', {
            className: 'ghp-textarea',
            value: draft ?? '',
            placeholder: t('contentPlaceholder'),
            onChange: (event) => setDraft(event.target.value),
          }),
          h('div', { className: 'ghp-row' },
            h('button', { type: 'button', className: 'ghp-ghost', onClick: useSession }, t('sourceSession')),
            h('span', { className: 'ghp-count' },
              transcript.total === 0
                ? ''
                : t('sessionRange')
                  .replace('{part}', String(transcript.included))
                  .replace('{total}', String(transcript.total)),
            ),
            h('label', { className: 'ghp-check' },
              h('input', { type: 'checkbox', checked: isPublic, onChange: (event) => setIsPublic(event.target.checked === true) }),
              t('publicLabel'),
            ),
          ),
          h('div', { className: 'ghp-note' }, t('introNote')),
          h('div', { className: 'ghp-actions' },
            statusNode,
            h('button', { type: 'button', className: 'ghp-ghost', onClick: () => setOpen(false) }, t('cancel')),
            h('button', { type: 'button', className: 'ghp-primary', disabled: publishing, onClick: () => { publish(); } }, publishing ? '…' : t('publish')),
          ),
        );

        const icon = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
          h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z' }),
        );

        return h('div', { className: 'ghp-root' },
          h('style', null, CSS),
          h('button', {
            type: 'button',
            className: 'ghp-button',
            'aria-pressed': open,
            title: t('button'),
            onMouseDown: (event) => event.preventDefault(),
            onClick: toggle,
          },
            icon,
            h('span', null, t('button')),
            account !== null && account.ok === true ? h('span', { className: 'ghp-dot on' }) : null,
          ),
          panel,
        );
      }

      return Boundary === null ? Button : withBoundary(Boundary, Button);
    }

    return {
      name: 'github-publisher-client',
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale');
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, 'zh', zh));
          ctx.effect(() => locale.register(NS, 'en', en));
        }
        const translate = locale !== undefined && typeof locale.bind === 'function'
          ? locale.bind(NS)
          : (key) => (typeof zh[key] === 'string' ? zh[key] : key);
        const t = (key) => {
          const value = translate(key);
          return typeof value === 'string' && value.length > 0 ? value : key;
        };

        const Button = createButton(ctx, t);

        ctx.slots.inject(SLOT, () => ctx.slots.register(
          { name: SLOT, id: 'github-publisher', order: 40, label: () => t('button') },
          Button,
        ));
      },
    };
  },
});
