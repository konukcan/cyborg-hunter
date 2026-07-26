// src/core/index.js
// Package entry point. Exports init() and static utilities.
//
// IMPORTANT: Do NOT manually assign window.CyborgHunter here.
// esbuild's globalName: 'CyborgHunter' handles the IIFE global assignment,
// and the build footer adds window.IntegrityMonitor = CyborgHunter.
// Manual assignment would create a second object, causing state divergence.

import { init } from './monitor.js';
import { VERSION } from '../shared/constants.js';
import { preventTextSelection, addHoneypot, setAltText } from './signals/dom-protection.js';

export { init, VERSION, preventTextSelection, addHoneypot, setAltText };
