import { createRoot } from 'react-dom/client';
import { App } from './App';
import { start } from './engine';
import '../style.css';

start();
createRoot(document.getElementById('root')!).render(<App />);
