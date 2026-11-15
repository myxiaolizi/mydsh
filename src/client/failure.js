/**
 * Turning a failed request into a sentence in the active language.
 *
 * A transport failure carries no Host prose, only a machine code, and the browser's
 * own text for it — "Failed to fetch", "The user aborted a request" — is English no
 * matter what language the session is in. Showing that text inside a Chinese page is
 * the defect this module exists to prevent.
 *
 * The rule: translate what has a known code, and pass through what does not. A Host
 * that sent its own message is the authority on its own diagnostics, so that message
 * is shown as it arrived rather than replaced with something vaguer.
 */
/** Codes this plugin maps to its own wording. */
const CODE_KEYS = Object.freeze({
  network: 'error.network',
  'bad-response': 'error.badResponse',
  unauthorized: 'error.unauthorized',
  forbidden: 'error.unauthorized',
  'not-found': 'error.notFound',
  internal: 'error.server',
  server: 'error.server',
  timeout: 'error.timeout',
  aborted: 'error.aborted',
});

/**
 * Describe one failure.
 *
 * `t` is the translator, so this stays a pure function and can be reused outside a
 * component (a click handler, for instance).
 */
export function describeFailure(t, failure) {
  if (failure === undefined || failure === null) return t('error.unknown');

  const code = typeof failure === 'string' ? undefined : failure.code;
  const message = typeof failure === 'string' ? failure : failure.message;

  // A code we recognize wins: its wording is written for this interface, while the
  // message may be the browser's English.
  const key = code === undefined ? undefined : CODE_KEYS[code];
  if (key !== undefined) {
    // A recognized code still carries useful detail sometimes, but only when it came
    // from the Host rather than the transport.
    if (code !== 'network' && code !== 'aborted' && typeof message === 'string'
      && message !== '' && !looksLikeBrowserText(message)) {
      return `${t(key)} ${t('error.detail', { message })}`;
    }
    return t(key);
  }

  // No code: a thrown string or an unknown shape. Show whatever detail exists.
  if (typeof message === 'string' && message !== '') {
    if (looksLikeBrowserText(message)) return `${t('error.unknown')} ${t('error.detail', { message: message })}`;
    return message;
  }
  return t('error.unknown');
}

/**
 * Whether a message is the browser's own transport text.
 *
 * Recognising it matters because it is the one case where the message is definitely
 * not localized and definitely not informative — a user cannot act on "Failed to
 * fetch". These strings come from the platform, so they are stable.
 */
function looksLikeBrowserText(message) {
  return /failed to fetch|networkerror|load failed|the operation was aborted|the user aborted|aborterror|typeerror/i
    .test(message);
}
