import lifecycle from '../installer/lifecycle.js';
import { resolveMode } from '../engine/mode-resolver.js';
export async function register(context){ return {addonId:'mcp',routes:'backend/routes.js',lifecycle,mode:()=>resolveMode(context)}; }
export default {register};