/**
 * Retry policy panel.
 *
 * Retry is the feature most likely to make things worse if misconfigured, so the
 * panel shows the resolved decision for a test failure rather than only accepting
 * numbers. A user can paste an error and see exactly which rule would claim it and
 * how long the engine would wait.
 *
 * Every user-facing string is translated through `usePanelT`, so the panel follows
 * DSH's active language. Error kinds and outcomes arrive from the Host as stable
 * ids; they are mapped to translated labels for display only, so the values written
 * back to settings are unchanged.
 */
import React from 'react';
import { Badge, Card, Empty, Segments, cx, formatRelative } from './ui.js';
import { api, useAsync } from './data.js';
import { FieldForm, FieldRow, ModuleToggle, useSettings } from './settings-page.js';
import { useT, useFailureText } from './i18n-react.js';

const h = React.createElement;

/**
 * The panel's translate function.
 *
 * The panel's strings live in the shared `i18n.js` dictionary, so this is a thin
 * alias of `useT`. It is kept as a named helper because every call site in this
 * panel already reads through it, and one name is easier to follow than importing
 * the hook in a dozen places.
 */
function usePanelT() {
  return useT();
}

/** Error kinds, matching the Host classifier. Values are ids; only labels translate. */
const KINDS = [
  ['rate-limit', 'retry.kind.rateLimit'],
  ['overloaded', 'retry.kind.overloaded'],
  ['server-error', 'retry.kind.serverError'],
  ['timeout', 'retry.kind.timeout'],
  ['network', 'retry.kind.network'],
  ['auth', 'retry.kind.auth'],
  ['quota', 'retry.kind.quota'],
  ['context-overflow', 'retry.kind.contextOverflow'],
  ['invalid-request', 'retry.kind.invalidRequest'],
  ['content-filter', 'retry.kind.contentFilter'],
  ['model-unavailable', 'retry.kind.modelUnavailable'],
  ['unknown', 'retry.kind.unknown'],
];

const KIND_LABELS = new Map(KINDS);

/**
 * Display label for a Host-supplied kind id.
 *
 * An unknown id is shown as-is: the Host may add a kind before this plugin ships a
 * translation for it, and a raw id is more useful than an empty badge.
 */
function kindLabel(t, kind) {
  if (typeof kind !== 'string') return String(kind);
  const key = KIND_LABELS.get(kind);
  return key === undefined ? kind : t(key);
}

/** Display label for a recorded retry outcome. */
function outcomeLabel(t, outcome) {
  switch (outcome) {
    case 'succeeded':
      return t('retry.succeeded');
    case 'exhausted':
      return t('retry.exhausted');
    case 'retrying':
      return t('retry.retrying');
    default:
      return outcome ?? '—';
  }
}

export function RetryPanel() {
  const { settings, update } = useSettings();
  const t = usePanelT();
  const config = settings?.retry ?? {};
  const enabled = config.enabled === true;
  const policies = Array.isArray(config.policies) ? config.policies : [];
  const alternatives = Array.isArray(config.alternatives) ? config.alternatives : [];

  const status = useAsync(() => api.retry(), [], { immediate: enabled });

  const addPolicy = () => {
    update('retry', {
      policies: [...policies, {
        id: `policy_${Date.now()}`,
        name: t('retry.newPolicy'),
        enabled: true,
        errorKinds: ['rate-limit', 'overloaded'],
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        switchModel: false,
        switchProvider: false,
        switchAfter: 1,
      }],
    });
  };

  const patchPolicy = (index, patch) => {
    update('retry', { policies: policies.map((policy, position) => (position === index ? { ...policy, ...patch } : policy)) });
  };

  const removePolicy = (index) => {
    update('retry', { policies: policies.filter((_, position) => position !== index) });
  };

  const addAlternative = () => {
    update('retry', { alternatives: [...alternatives, { provider: '', model: '' }] });
  };

  const patchAlternative = (index, patch) => {
    update('retry', {
      alternatives: alternatives.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)),
    });
  };

  const removeAlternative = (index) => {
    update('retry', { alternatives: alternatives.filter((_, position) => position !== index) });
  };

  return h('div', { className: 'mydsh-stack', style: { gap: 'var(--mydsh-space-4)' } },
    h(ModuleToggle, {
      section: 'retry',
      titleKey: 'retry.title',
      descriptionKey: 'retry.description',
    }),

    enabled ? h(React.Fragment, null,
      h(Card, { title: t('retry.defaults'), description: t('retry.defaultsHint') },
        h(FieldForm, { section: 'retry' }),
      ),

      h(Card, {
        title: t('retry.policies'),
        description: t('retry.policiesHint'),
        actions: h('button', { type: 'button', className: 'mydsh-btn mydsh-btn-sm', onClick: addPolicy }, t('retry.addPolicy')),
      },
        policies.length === 0
          ? h(Empty, { title: t('retry.noPolicies'), hint: t('retry.noPoliciesHint') })
          : policies.map((policy, index) =>
            h(PolicyEditor, {
              key: policy.id ?? index,
              policy,
              onChange: (patch) => patchPolicy(index, patch),
              onRemove: () => removePolicy(index),
            }),
          ),
      ),

      h(Card, {
        title: t('retry.alternatives'),
        description: t('retry.alternativesHint'),
        actions: h('button', { type: 'button', className: 'mydsh-btn mydsh-btn-sm', onClick: addAlternative }, t('retry.addRoute')),
      },
        alternatives.length === 0
          ? h(Empty, { title: t('retry.noAlternatives'), hint: t('retry.noAlternativesHint') })
          : alternatives.map((entry, index) =>
            h('div', { key: index, className: 'mydsh-row' },
              h('div', { className: 'mydsh-inline', style: { flex: 1 } },
                h('input', {
                  className: 'mydsh-input',
                  style: { width: 140 },
                  placeholder: t('retry.providerPlaceholder'),
                  value: entry.provider ?? '',
                  onChange: (event) => patchAlternative(index, { provider: event.target.value }),
                }),
                h('span', { className: 'mydsh-hint' }, '/'),
                h('input', {
                  className: 'mydsh-input',
                  style: { width: 180 },
                  placeholder: t('retry.modelPlaceholder'),
                  value: entry.model ?? '',
                  onChange: (event) => patchAlternative(index, { model: event.target.value }),
                }),
              ),
              h('button', {
                type: 'button',
                className: 'mydsh-btn mydsh-btn-sm mydsh-btn-danger',
                onClick: () => removeAlternative(index),
              }, t('common.remove')),
            ),
          ),
      ),

      h(ClassifierCard, null),

      h(Card, { title: t('retry.ledger'), description: t('retry.ledgerHint') },
        (status.data?.recent ?? []).length === 0
          ? h(Empty, { title: t('retry.noLedger') })
          : h('div', { className: 'mydsh-table-wrap' },
            h('table', { className: 'mydsh-table' },
              h('thead', null,
                h('tr', null,
                  h('th', null, t('retry.when')),
                  h('th', null, t('retry.kind')),
                  h('th', { className: 'num' }, t('retry.attempt')),
                  h('th', null, t('retry.outcome')),
                  h('th', { className: 'num' }, t('retry.wait')),
                ),
              ),
              h('tbody', null,
                status.data.recent.map((entry, index) =>
                  h('tr', { key: index },
                    h('td', { className: 'mydsh-hint' }, formatRelative(entry.at)),
                    h('td', null, h(Badge, null, kindLabel(t, entry.kind))),
                    h('td', { className: 'num' }, entry.attempt ?? '—'),
                    h('td', null,
                      h(Badge, {
                        tone: entry.outcome === 'succeeded' ? 'success'
                          : entry.outcome === 'exhausted' ? 'danger'
                            : entry.outcome === 'retrying' ? 'warn' : undefined,
                        // The tone decision above uses the raw id; only the label is translated.
                      }, outcomeLabel(t, entry.outcome)),
                    ),
                    // `ms` is a unit and stays as-is.
                    h('td', { className: 'num' }, entry.delayMs === undefined ? '—' : `${entry.delayMs}ms`),
                  ),
                ),
              ),
            ),
          ),
      ),
    ) : null,
  );
}

/** One policy row group. */
function PolicyEditor({ policy, onChange, onRemove }) {
  const t = usePanelT();
  const kinds = Array.isArray(policy.errorKinds) ? policy.errorKinds : [];
  const toggleKind = (kind) => {
    onChange({ errorKinds: kinds.includes(kind) ? kinds.filter((entry) => entry !== kind) : [...kinds, kind] });
  };

  return h('div', { className: 'mydsh-card', style: { background: 'var(--mydsh-surface-sunken)' } },
    h('div', { className: 'mydsh-card-head' },
      h('input', {
        className: 'mydsh-input',
        style: { width: 200, fontWeight: 600 },
        value: policy.name ?? '',
        'aria-label': t('retry.policyName'),
        onChange: (event) => onChange({ name: event.target.value }),
      }),
      h('div', { className: 'mydsh-inline' },
        h('button', {
          type: 'button',
          className: 'mydsh-switch',
          'data-on': policy.enabled !== false ? 'true' : 'false',
          role: 'switch',
          'aria-checked': policy.enabled !== false,
          'aria-label': policy.enabled !== false ? t('common.enabled') : t('common.disabled'),
          onClick: () => onChange({ enabled: policy.enabled === false }),
        }),
        h('button', { type: 'button', className: 'mydsh-btn mydsh-btn-sm mydsh-btn-danger', onClick: onRemove }, t('common.remove')),
      ),
    ),

    h('div', null,
      h('span', { className: 'mydsh-row-hint' }, t('retry.errorKinds')),
      h('div', { className: 'mydsh-inline', style: { marginTop: 6 } },
        KINDS.map(([value, labelKey]) =>
          h('button', {
            key: value,
            type: 'button',
            className: 'mydsh-segment',
            'data-active': kinds.includes(value) ? 'true' : 'false',
            style: {
              border: '1px solid var(--mydsh-border)',
              background: kinds.includes(value) ? 'var(--mydsh-accent-soft)' : 'transparent',
              color: kinds.includes(value) ? 'var(--mydsh-accent-text)' : 'var(--mydsh-text-muted)',
            },
            onClick: () => toggleKind(value),
          }, t(labelKey)),
        ),
      ),
    ),

    h('div', { className: 'mydsh-grid' },
      h(FieldRow, { label: t('retry.maxAttempts') },
        h('input', {
          className: 'mydsh-input',
          type: 'number',
          style: { width: 80 },
          min: 1,
          max: 10,
          value: policy.maxAttempts ?? 3,
          onChange: (event) => onChange({ maxAttempts: Number(event.target.value) }),
        }),
      ),
      h(FieldRow, { label: t('retry.initialDelay') },
        h('input', {
          className: 'mydsh-input',
          type: 'number',
          style: { width: 90 },
          min: 0,
          step: 100,
          value: policy.initialDelayMs ?? 1000,
          onChange: (event) => onChange({ initialDelayMs: Number(event.target.value) }),
        }),
      ),
      h(FieldRow, { label: t('retry.maxDelay') },
        h('input', {
          className: 'mydsh-input',
          type: 'number',
          style: { width: 90 },
          min: 1000,
          step: 1000,
          value: policy.maxDelayMs ?? 30000,
          onChange: (event) => onChange({ maxDelayMs: Number(event.target.value) }),
        }),
      ),
      h(FieldRow, { label: t('retry.switchAfter') },
        h('input', {
          className: 'mydsh-input',
          type: 'number',
          style: { width: 80 },
          min: 1,
          value: policy.switchAfter ?? 1,
          onChange: (event) => onChange({ switchAfter: Number(event.target.value) }),
        }),
      ),
    ),

    h('div', { className: 'mydsh-inline' },
      h('button', {
        type: 'button',
        className: 'mydsh-switch',
        'data-on': policy.switchModel === true ? 'true' : 'false',
        role: 'switch',
        'aria-checked': policy.switchModel === true,
        'aria-label': t('retry.switchModel'),
        onClick: () => onChange({ switchModel: policy.switchModel !== true }),
      }),
      h('span', { className: 'mydsh-row-label' }, t('retry.switchModel')),
      h('span', { className: 'mydsh-spacer' }),
      h('button', {
        type: 'button',
        className: 'mydsh-switch',
        'data-on': policy.switchProvider === true ? 'true' : 'false',
        role: 'switch',
        'aria-checked': policy.switchProvider === true,
        'aria-label': t('retry.switchProvider'),
        onClick: () => onChange({ switchProvider: policy.switchProvider !== true }),
      }),
      h('span', { className: 'mydsh-row-label' }, t('retry.switchProvider')),
    ),
  );
}

/**
 * Classifier playground.
 *
 * Lets a user check how a real error message is classified, which is the one part
 * of retry behavior that is not obvious from the controls.
 */
function ClassifierCard() {
  const t = usePanelT();
  const describe = useFailureText();
  const [message, setMessage] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [result, setResult] = React.useState(undefined);
  const [busy, setBusy] = React.useState(false);

  const classify = async () => {
    setBusy(true);
    try {
      setResult(await api.retryTest({
        message,
        status: status === '' ? undefined : Number(status),
      }));
    } catch (error) {
      // The raw failure is kept; the render site turns it into the active language.
      setResult({ error });
    } finally {
      setBusy(false);
    }
  };

  return h(Card, { title: t('retry.test'), description: t('retry.testHint') },
    h('div', { className: 'mydsh-inline' },
      h('input', {
        className: 'mydsh-input',
        style: { flex: 1, minWidth: 200 },
        placeholder: t('retry.testPlaceholder'),
        value: message,
        onChange: (event) => setMessage(event.target.value),
      }),
      h('input', {
        className: 'mydsh-input',
        type: 'number',
        style: { width: 90 },
        placeholder: t('retry.statusPlaceholder'),
        value: status,
        onChange: (event) => setStatus(event.target.value),
      }),
      h('button', { type: 'button', className: 'mydsh-btn', disabled: busy, onClick: classify },
        busy ? t('retry.testing') : t('retry.classify')),
    ),
    result !== undefined
      ? result.error !== undefined
        ? h('p', { className: 'mydsh-error' }, describe(result.error))
        : h('div', { className: 'mydsh-stack' },
          h('div', { className: 'mydsh-inline' },
            h('span', { className: 'mydsh-hint' }, t('retry.kind')),
            h(Badge, { tone: 'accent' }, kindLabel(t, result.kind)),
            h(Badge, { tone: result.retryable ? 'success' : 'warn' },
              result.retryable ? t('retry.retryable') : t('retry.notRetryable')),
          ),
          h('div', { className: 'mydsh-inline' },
            h('span', { className: 'mydsh-hint' }, t('retry.preview')),
            // `ms` is a unit and stays as-is.
            (result.backoff ?? []).map((delay, index) =>
              h(Badge, { key: index }, `${index + 1}: ${delay}ms`),
            ),
          ),
        )
      : null,
  );
}
