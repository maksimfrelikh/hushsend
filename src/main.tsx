import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
// The two typefaces the kit's palette names (theme-mono.css): Archivo (variable) for text, IBM Plex
// Mono for codes, words and phrases. Self-hosted through the bundle — the CSP allows font-src 'self'
// only, and nothing may load from a CDN. (Onest, the Cyrillic companion, arrives with the RU copy.)
import '@fontsource-variable/archivo/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
// stark-ui-kit: the base/token layer first, then its monochrome house palette (the ONLY source of
// the --brand-* values — hushsend declares none of its own), then the component stylesheets the
// screens adopt (the lozenge controls, the theme toggle, the .wrap column), then the app layer.
import 'stark-ui-kit/styles.css';
import 'stark-ui-kit/theme-mono.css';
import 'stark-ui-kit/controls.css';
import 'stark-ui-kit/theme-toggle.css';
import 'stark-ui-kit/layout.css';
import './ui/app.css';
import { store } from './store';
import { defaultKeystore } from './core/keystore';
import { App } from './ui/App';

if (import.meta.env.DEV) {
  // DEV-only handles for the visual and a11y gates (visual/, tests/a11y/): they drive every screen
  // state by dispatching store actions and seeding pins, so a screenshot needs no peer and no
  // signaling server. Dead code in the production bundle.
  Object.assign(window, { __hsStore: store, __hsKeystore: defaultKeystore() });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
