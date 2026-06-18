import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
// stark-ui-kit base/token layer first, then our --brand-* overrides on top.
import 'stark-ui-kit/styles.css';
import './ui/theme.css';
import { store } from './store';
import { App } from './ui/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
