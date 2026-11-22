import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import { Toaster } from 'sonner';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <MotionConfig reducedMotion="user">
        <App />
        <Toaster
          theme="dark"
          position="top-center"
          toastOptions={{ style: { background: 'oklch(24% 0.06 355)', border: '1px solid oklch(100% 0 0 / 0.1)', color: 'oklch(91% 0.06 110)' } }}
        />
      </MotionConfig>
    </BrowserRouter>
  </React.StrictMode>,
);
