/**
 * React binding for the plugin's localization.
 *
 * The dictionaries live in `i18n.js`, which is deliberately free of React so it can
 * be tested in plain Node. This module adds the one piece a component tree needs:
 * a context that re-renders consumers when the shell's locale changes.
 *
 * Two details matter for correctness:
 *
 *  - The provider subscribes to the locale service rather than polling it, so a
 *    language switch repaints the plugin in the same frame as the rest of the app.
 *  - `useT` returns a stable function per locale, so memoized children do not
 *    re-render on every keystroke elsewhere in the tree.
 */
import React from 'react';
import { createTranslator, makeTranslator } from './i18n.js';
import { describeFailure } from './failure.js';

const h = React.createElement;

/** Current translator; `undefined` outside a provider. */
const TranslateContext = React.createContext(undefined);

/**
 * Provider that owns the translator.
 *
 * `ctx` is the Client context handed to `apply`. It is optional so the components
 * remain renderable in tests and in any surface mounted without one.
 */
export function I18nProvider({ ctx, children }) {
  const [locale, setLocale] = React.useState(() => currentLocale(ctx));

  React.useEffect(() => {
    // Registering inside the effect keeps activation free of side effects that
    // would run before the shell finished mounting.
    const handle = createTranslator(ctx, (next) => {
      setLocale(next ?? currentLocale(ctx));
    });
    setLocale(currentLocale(ctx));
    return () => handle.subscribe();
  }, [ctx]);

  const value = React.useMemo(() => ({
    t: makeTranslator(locale),
    locale,
  }), [locale]);

  return h(TranslateContext.Provider, { value }, children);
}

/** The active translate function. */
export function useT() {
  const value = React.useContext(TranslateContext);
  if (value === undefined) {
    // A surface mounted outside the provider still renders readable text rather
    // than throwing, which keeps a partially mounted page usable.
    return makeTranslator('en');
  }
  return value.t;
}

/** The active locale id, for the rare surface that needs to branch on it. */
export function useLocale() {
  const value = React.useContext(TranslateContext);
  return value?.locale ?? 'en';
}

/** Read the shell's active locale without throwing when the service is absent. */
function currentLocale(ctx) {
  try {
    const active = ctx?.get?.('locale')?.getLocale?.()?.active;
    return typeof active === 'string' && active !== '' ? active : 'en';
  } catch {
    return 'en';
  }
}

/**
 * A component-bound failure describer.
 *
 * `describeFailure` lives in `failure.js` with no React dependency so it can be tested
 * in plain Node; this hook is the version a component uses. Keeping the split means
 * the wording logic does not need a React install to be verified.
 */
export function useFailureText() {
  const t = useT();
  return React.useMemo(() => (failure) => describeFailure(t, failure), [t]);
}
