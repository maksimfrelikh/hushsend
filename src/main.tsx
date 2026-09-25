import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
// stark-ui-kit base/token layer first, then its monochrome house palette (the ONLY source of the
// --brand-* values — hushsend declares none of its own), then the app component layer.
import 'stark-ui-kit/styles.css';
import 'stark-ui-kit/theme-mono.css';
import './ui/app.css';
import { store } from './store';
import { App } from './ui/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
